require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

const JWT_SECRET = process.env.JWT_SECRET || 'super-secret-key-change-in-production';

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ランク判定ヘルパー
function getRankInfo(points) {
    if (points >= 1900) return { name: 'GOAT', badge: '🐐GOAT', color: '#ff007f' };
    if (points >= 1400) return { name: 'マスター', badge: '👑マスター', color: '#9b59b6' };
    if (points >= 1000) return { name: 'エメラルド', badge: '❇️エメラルド', color: '#2ecc71' };
    if (points >= 700)  return { name: 'ダイア', badge: '💎ダイア', color: '#3498db' };
    if (points >= 450)  return { name: 'プラチナ', badge: '💠プラチナ', color: '#1abc9c' };
    if (points >= 250)  return { name: 'ゴールド', badge: '🥇ゴールド', color: '#f1c40f' };
    if (points >= 100)  return { name: 'シルバー', badge: '🥈シルバー', color: '#95a5a6' };
    return { name: 'ブロンズ', badge: '🥉ブロンズ', color: '#cd7f32' };
}

// ランキングデータ取得＆全クライアントへリアルタイム配信するヘルパー
async function fetchRankingsData() {
    const winsRes = await pool.query(
        'SELECT username, wins, rank_points FROM users ORDER BY wins DESC, rank_points DESC LIMIT 5'
    );
    const rankRes = await pool.query(
        'SELECT username, rank_points, wins FROM users ORDER BY rank_points DESC, wins DESC LIMIT 5'
    );
    const format = (rows) => rows.map(r => ({
        ...r,
        rankInfo: getRankInfo(r.rank_points)
    }));
    return {
        byWins: format(winsRes.rows),
        byRank: format(rankRes.rows)
    };
}

async function broadcastRankings() {
    try {
        const data = await fetchRankingsData();
        io.emit('rankingsUpdated', data);
    } catch (e) {
        console.error('ランキングブロードキャストエラー:', e);
    }
}

// 認証ミドルウェア
function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.sendStatus(401);

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.sendStatus(403);
        req.user = user;
        next();
    });
}

// ================= REST API =================

// 新規登録（登録後すぐにログインできるようトークンを発行）
app.post('/api/register', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password || username.length > 20) {
        return res.status(400).json({ error: 'ユーザー名(20文字以内)とパスワードを入力してください。' });
    }
    try {
        const hash = await bcrypt.hash(password, 10);
        const result = await pool.query(
            'INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id, username',
            [username, hash]
        );
        const newUser = result.rows[0];
        const token = jwt.sign({ id: newUser.id, username: newUser.username }, JWT_SECRET, { expiresIn: '7d' });

        await broadcastRankings();
        res.json({ token, username: newUser.username });
    } catch (err) {
        if (err.code === '23505') {
            return res.status(400).json({ error: 'そのユーザー名は既に使用されています。' });
        }
        res.status(500).json({ error: 'サーバーエラーが発生しました。' });
    }
});

// ログイン
app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
        const user = result.rows[0];
        if (!user || !(await bcrypt.compare(password, user.password_hash))) {
            return res.status(401).json({ error: 'ユーザー名またはパスワードが間違っています。' });
        }
        const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
        res.json({ token, username: user.username });
    } catch (err) {
        res.status(500).json({ error: 'ログインエラー' });
    }
});

// ユーザー統計・情報取得
app.get('/api/me', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT id, username, rank_points, max_rank_points, games_played, wins FROM users WHERE id = $1',
            [req.user.id]
        );
        if (result.rows.length === 0) return res.sendStatus(404);
        const u = result.rows[0];
        const winRate = u.games_played > 0 ? Math.round((u.wins / u.games_played) * 100) : 0;
        res.json({
            ...u,
            winRate,
            currentRank: getRankInfo(u.rank_points),
            maxRank: getRankInfo(u.max_rank_points)
        });
    } catch (err) {
        res.status(500).json({ error: 'データ取得エラー' });
    }
});

// ランキング取得（勝利数トップ5 & ランク上位トップ5）
app.get('/api/rankings', async (req, res) => {
    try {
        const data = await fetchRankingsData();
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: 'ランキング取得エラー' });
    }
});

// パスワード変更
app.post('/api/change-password', authenticateToken, async (req, res) => {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
        return res.status(400).json({ error: 'すべての項目を入力してください。' });
    }
    try {
        const result = await pool.query('SELECT * FROM users WHERE id = $1', [req.user.id]);
        const user = result.rows[0];
        if (!user || !(await bcrypt.compare(currentPassword, user.password_hash))) {
            return res.status(400).json({ error: '現在のパスワードが一致しません。' });
        }
        const newHash = await bcrypt.hash(newPassword, 10);
        await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [newHash, req.user.id]);
        res.json({ message: 'パスワードを変更しました。再ログインしてください。' });
    } catch (err) {
        res.status(500).json({ error: '変更エラー' });
    }
});

// アカウント削除
app.delete('/api/account', authenticateToken, async (req, res) => {
    try {
        await pool.query('DELETE FROM users WHERE id = $1', [req.user.id]);
        await broadcastRankings();
        res.json({ message: 'アカウントを削除しました。' });
    } catch (err) {
        res.status(500).json({ error: '削除エラー' });
    }
});

// ================= SOCKET.IO リアルタイム対戦管理 =================

const rooms = new Map();
const rankedQueues = { 2: [], 3: [] };

// 4桁の数字コード生成
function generateRoomCode() {
    let code = '';
    for (let i = 0; i < 4; i++) {
        code += Math.floor(Math.random() * 10).toString();
    }
    return rooms.has(code) ? generateRoomCode() : code;
}

// クライアントに送信する安全なルーム情報（ランダムモード時は目標数字を隠す）
function serializeRoom(room) {
    return {
        id: room.id,
        hostId: room.hostId,
        isRanked: room.isRanked,
        state: room.state,
        isRandomTarget: room.isRandomTarget,
        targetNumber: room.isRandomTarget ? null : room.targetNumber,
        turnTimeLimit: room.turnTimeLimit,
        players: room.players
    };
}

// DB結果更新
async function updateMatchResults(players, loserId, isRanked) {
    const results = [];
    for (const p of players) {
        const isLoser = (p.userId === loserId);
        const isWinner = !isLoser;
        let pointChange = 0;

        try {
            const dbRes = await pool.query('SELECT rank_points, max_rank_points FROM users WHERE id = $1', [p.userId]);
            if (dbRes.rows.length === 0) continue;
            let { rank_points, max_rank_points } = dbRes.rows[0];
            const currentRank = getRankInfo(rank_points);

            if (isRanked) {
                if (isWinner) {
                    pointChange = Math.floor(Math.random() * (40 - 25 + 1)) + 25;
                } else {
                    if (currentRank.name === 'ブロンズ' || currentRank.name === 'シルバー') {
                        pointChange = -Math.floor(Math.random() * 11);
                    } else {
                        pointChange = -(Math.floor(Math.random() * (30 - 10 + 1)) + 10);
                    }
                }
            }

            let newPoints = Math.max(0, rank_points + pointChange);
            let actualDiff = newPoints - rank_points;
            let newMax = Math.max(max_rank_points, newPoints);

            await pool.query(
                `UPDATE users 
                 SET games_played = games_played + 1,
                     wins = wins + $1,
                     rank_points = $2,
                     max_rank_points = $3
                 WHERE id = $4`,
                [isWinner ? 1 : 0, newPoints, newMax, p.userId]
            );

            results.push({
                userId: p.userId,
                username: p.username,
                isWinner,
                pointChange: isRanked ? actualDiff : null,
                newPoints,
                rankInfo: getRankInfo(newPoints)
            });
        } catch (e) {
            console.error('DB更新エラー:', e);
        }
    }

    await broadcastRankings();
    return results;
}

function startTurnTimer(room) {
    if (room.timer) clearInterval(room.timer);
    room.timeLeft = room.turnTimeLimit;

    room.timer = setInterval(async () => {
        room.timeLeft -= 1;
        io.to(room.id).emit('timerTick', { timeLeft: room.timeLeft, maxTime: room.turnTimeLimit });

        if (room.timeLeft <= 0) {
            clearInterval(room.timer);
            const currentPlayer = room.players[room.turnIndex];
            await finishGame(room, currentPlayer.userId, `${currentPlayer.username}さんが時間切れになりました！`);
        }
    }, 1000);
}

// ターン交代共通処理
function advanceTurn(room, currentPlayer) {
    const added = room.turnAdded;
    room.turnAdded = 0;
    room.turnIndex = (room.turnIndex + 1) % room.players.length;

    io.to(room.id).emit('chatMessage', {
        system: true,
        text: `${currentPlayer.username}さんが +${added} 追加しました！`
    });

    io.to(room.id).emit('turnChanged', {
        turnIndex: room.turnIndex,
        currentNumber: room.currentNumber
    });

    startTurnTimer(room);
}

async function finishGame(room, loserUserId, reasonText) {
    if (room.state === 'finished') return;
    room.state = 'finished';
    if (room.timer) clearInterval(room.timer);

    const results = await updateMatchResults(room.players, loserUserId, room.isRanked);

    io.to(room.id).emit('gameOver', {
        reason: reasonText,
        results,
        isRanked: room.isRanked,
        rankedMode: room.rankedMode || null
    });

    if (room.isRanked) {
        room.players.forEach(p => {
            const s = io.sockets.sockets.get(p.socketId);
            if (s) {
                s.leave(room.id);
                s.roomId = null;
            }
        });
        rooms.delete(room.id);
    } else {
        // カスタム部屋の場合は解散せずロビー状態に戻す
        room.state = 'lobby';
        room.currentNumber = 0;
        room.turnIndex = 0;
        room.turnAdded = 0;
        room.players.forEach(p => {
            p.ready = (p.userId === room.hostId);
        });
        io.to(room.id).emit('roomUpdated', serializeRoom(room));
    }
}

function beginCountdownAndStart(room) {
    // ランダム設定の場合はここで初めて30〜50の数字を決定
    if (room.isRandomTarget) {
        room.targetNumber = Math.floor(Math.random() * (50 - 30 + 1)) + 30;
    }

    room.state = 'countdown';
    let count = 3;
    io.to(room.id).emit('countdown', count);

    const cdInterval = setInterval(() => {
        count -= 1;
        if (count > 0) {
            io.to(room.id).emit('countdown', count);
        } else {
            clearInterval(cdInterval);
            room.state = 'playing';
            room.currentNumber = 0;
            room.turnIndex = 0;
            room.turnAdded = 0;

            io.to(room.id).emit('gameStarted', {
                targetNumber: room.targetNumber,
                players: room.players,
                turnIndex: room.turnIndex,
                currentNumber: room.currentNumber,
                timeLimit: room.turnTimeLimit,
                isRanked: room.isRanked
            });
            startTurnTimer(room);
        }
    }, 1000);
}

io.use(async (socket, next) => {
    const token = socket.handshake.auth.token;
    if (!token) return next(new Error('認証エラー'));
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        const res = await pool.query('SELECT id, username, rank_points FROM users WHERE id = $1', [decoded.id]);
        if (res.rows.length === 0) return next(new Error('ユーザーが存在しません'));
        socket.user = {
            id: res.rows[0].id,
            username: res.rows[0].username,
            rankInfo: getRankInfo(res.rows[0].rank_points)
        };
        next();
    } catch (err) {
        next(new Error('トークン無効'));
    }
});

io.on('connection', (socket) => {
    // カスタム部屋作成（押したら即座に部屋作成しロビー画面へ）
    socket.on('createRoom', () => {
        const code = generateRoomCode();
        const room = {
            id: code,
            hostId: socket.user.id,
            isRanked: false,
            state: 'lobby',
            isRandomTarget: false,
            targetNumber: 30,
            turnTimeLimit: 30,
            players: [{
                socketId: socket.id,
                userId: socket.user.id,
                username: socket.user.username,
                rankInfo: socket.user.rankInfo,
                ready: true
            }],
            currentNumber: 0,
            turnIndex: 0,
            turnAdded: 0,
            timer: null
        };

        rooms.set(code, room);
        socket.join(code);
        socket.roomId = code;
        socket.emit('roomJoined', serializeRoom(room));
    });

    // 4桁の数字コードで参加
    socket.on('joinRoom', ({ code }) => {
        const roomCode = (code || '').trim();
        const room = rooms.get(roomCode);
        if (!room) return socket.emit('errorMsg', '部屋が見つかりません。');
        if (room.state !== 'lobby') return socket.emit('errorMsg', '既にゲームが開始されています。');
        if (room.players.length >= 6) return socket.emit('errorMsg', '部屋が満員です。');
        if (room.players.some(p => p.userId === socket.user.id)) return socket.emit('errorMsg', '既に参加しています。');

        room.players.push({
            socketId: socket.id,
            userId: socket.user.id,
            username: socket.user.username,
            rankInfo: socket.user.rankInfo,
            ready: false
        });

        socket.join(roomCode);
        socket.roomId = roomCode;
        const serialized = serializeRoom(room);
        socket.emit('roomJoined', serialized);
        io.to(roomCode).emit('roomUpdated', serialized);
    });

    // ホストによる部屋ルール（目標数字・ランダム切替・制限時間）のリアルタイム変更
    socket.on('updateRoomSettings', ({ isRandomTarget, targetNumber, turnTimeLimit }) => {
        const room = rooms.get(socket.roomId);
        if (!room || room.state !== 'lobby' || room.hostId !== socket.user.id) return;

        room.isRandomTarget = Boolean(isRandomTarget);
        if (!room.isRandomTarget) {
            room.targetNumber = Math.max(10, Math.min(200, parseInt(targetNumber) || 30));
        }
        // 制限時間は10秒〜90秒（1分30秒）の間
        room.turnTimeLimit = Math.max(10, Math.min(90, parseInt(turnTimeLimit) || 30));

        io.to(room.id).emit('roomUpdated', serializeRoom(room));
    });

    // 準備OK切り替え
    socket.on('toggleReady', () => {
        const room = rooms.get(socket.roomId);
        if (!room || room.state !== 'lobby') return;
        const player = room.players.find(p => p.userId === socket.user.id);
        if (player) {
            player.ready = !player.ready;
            io.to(room.id).emit('roomUpdated', serializeRoom(room));
        }
    });

    // 順番シャッフル（ホストのみ）
    socket.on('shuffleOrder', () => {
        const room = rooms.get(socket.roomId);
        if (!room || room.state !== 'lobby' || room.hostId !== socket.user.id) return;
        for (let i = room.players.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [room.players[i], room.players[j]] = [room.players[j], room.players[i]];
        }
        io.to(room.id).emit('roomUpdated', serializeRoom(room));
    });

    // ゲーム開始（通常スタート / 強制スタート）
    socket.on('startCustomGame', ({ force }) => {
        const room = rooms.get(socket.roomId);
        if (!room || room.state !== 'lobby' || room.hostId !== socket.user.id) return;
        if (room.players.length < 2) {
            return socket.emit('errorMsg', '2人以上のプレイヤーが必要です。');
        }
        if (!force && !room.players.every(p => p.ready)) {
            return socket.emit('errorMsg', '全員が準備OKになっていません。');
        }
        beginCountdownAndStart(room);
    });

    // ロビーに戻る（部屋退出）
    socket.on('leaveLobby', () => {
        handlePlayerLeave(socket);
    });

    // オンラインランクマッチ参加 (mode: 2 or 3)
    socket.on('joinRanked', ({ mode }) => {
        const m = mode === 3 ? 3 : 2;
        rankedQueues[2] = rankedQueues[2].filter(s => s.user.id !== socket.user.id);
        rankedQueues[3] = rankedQueues[3].filter(s => s.user.id !== socket.user.id);

        rankedQueues[m].push(socket);
        socket.rankedMode = m;
        socket.emit('searchingRanked', { mode: m, current: rankedQueues[m].length });

        if (rankedQueues[m].length >= m) {
            const matchedSockets = rankedQueues[m].splice(0, m);
            const code = 'RANK-' + generateRoomCode();

            const room = {
                id: code,
                hostId: null,
                isRanked: true,
                rankedMode: m,
                state: 'countdown',
                isRandomTarget: true,
                targetNumber: 30,
                turnTimeLimit: 30,
                players: matchedSockets.map(s => ({
                    socketId: s.id,
                    userId: s.user.id,
                    username: s.user.username,
                    rankInfo: s.user.rankInfo,
                    ready: true
                })),
                currentNumber: 0,
                turnIndex: 0,
                turnAdded: 0,
                timer: null
            };

            room.players.sort(() => Math.random() - 0.5);

            rooms.set(code, room);
            matchedSockets.forEach(s => {
                s.rankedMode = null;
                s.join(code);
                s.roomId = code;
                s.emit('rankedMatched', serializeRoom(room));
            });

            beginCountdownAndStart(room);
        }
    });

    // ランクマッチ検索キャンセル
    socket.on('cancelRanked', () => {
        rankedQueues[2] = rankedQueues[2].filter(s => s.id !== socket.id);
        rankedQueues[3] = rankedQueues[3].filter(s => s.id !== socket.id);
        socket.rankedMode = null;
    });

    // 数字を増やす（3回押したら強制的に次のプレイヤーへチェンジ）
    socket.on('incrementNumber', async () => {
        const room = rooms.get(socket.roomId);
        if (!room || room.state !== 'playing') return;
        const currentPlayer = room.players[room.turnIndex];
        if (currentPlayer.userId !== socket.user.id) return;
        if (room.turnAdded >= 3) return;

        room.currentNumber += 1;
        room.turnAdded += 1;

        io.to(room.id).emit('numberUpdated', {
            currentNumber: room.currentNumber,
            targetNumber: room.targetNumber,
            turnAdded: room.turnAdded
        });

        // 決めた数字に達したら即負け
        if (room.currentNumber >= room.targetNumber) {
            io.to(room.id).emit('chatMessage', {
                system: true,
                text: `${currentPlayer.username}さんが +${room.turnAdded} 追加し、目標の ${room.targetNumber} に到達しました！`
            });
            await finishGame(room, currentPlayer.userId, `${currentPlayer.username}さんが「${room.targetNumber}」を言ってしまいました！`);
            return;
        }

        // 3回押したら強制的に次のユーザーへターンチェンジ
        if (room.turnAdded >= 3) {
            advanceTurn(room, currentPlayer);
        }
    });

    // ターン確定（1〜2回押した時点で次の人へ）
    socket.on('endTurn', () => {
        const room = rooms.get(socket.roomId);
        if (!room || room.state !== 'playing') return;
        const currentPlayer = room.players[room.turnIndex];
        if (currentPlayer.userId !== socket.user.id) return;

        if (room.turnAdded === 0) {
            return socket.emit('errorMsg', '最低1つは数字を増やしてください！');
        }

        advanceTurn(room, currentPlayer);
    });

    // ゲーム内チャット
    socket.on('sendChat', ({ message }) => {
        const room = rooms.get(socket.roomId);
        if (!room || !message || !message.trim()) return;
        io.to(room.id).emit('chatMessage', {
            system: false,
            sender: socket.user.username,
            badge: socket.user.rankInfo.badge,
            text: message.trim().slice(0, 100)
        });
    });

    // 切断・離脱処理
    socket.on('disconnect', () => {
        rankedQueues[2] = rankedQueues[2].filter(s => s.id !== socket.id);
        rankedQueues[3] = rankedQueues[3].filter(s => s.id !== socket.id);
        handlePlayerLeave(socket);
    });

    async function handlePlayerLeave(sock) {
        const room = rooms.get(sock.roomId);
        if (!room) return;

        if (room.state === 'lobby') {
            room.players = room.players.filter(p => p.userId !== sock.user.id);
            sock.leave(room.id);
            sock.roomId = null;

            if (room.players.length === 0) {
                rooms.delete(room.id);
            } else {
                if (room.hostId === sock.user.id) {
                    room.hostId = room.players[0].userId;
                    room.players[0].ready = true;
                }
                io.to(room.id).emit('roomUpdated', serializeRoom(room));
            }
        } else if (room.state === 'playing' || room.state === 'countdown') {
            const leaverId = sock.user.id;
            const leaverName = sock.user.username;

            await finishGame(room, leaverId, `${leaverName}さんがゲームから離脱しました！`);

            if (!room.isRanked) {
                room.players = room.players.filter(p => p.userId !== leaverId);
                sock.leave(room.id);
                sock.roomId = null;
                if (room.players.length === 0) {
                    rooms.delete(room.id);
                } else {
                    if (room.hostId === leaverId) {
                        room.hostId = room.players[0].userId;
                        room.players[0].ready = true;
                    }
                    io.to(room.id).emit('roomUpdated', serializeRoom(room));
                }
            }
        }
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});