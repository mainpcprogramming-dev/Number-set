let token = localStorage.getItem('token');
let currentUser = null;
let socket = null;
let authMode = 'login';
let rankingsData = { byWins: [], byRank: [] };
let currentRoom = null;
let lastRankedMode = 2;

// 初期化
window.onload = () => {
    if (token) {
        initApp();
    }
};

function showScreen(screenId) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.getElementById(screenId).classList.add('active');
}

function openModal(id) { document.getElementById(id).classList.add('active'); }
function closeModal(id) { document.getElementById(id).classList.remove('active'); }

// ================= 認証処理 =================
function switchAuthTab(mode) {
    authMode = mode;
    document.getElementById('tab-login').classList.toggle('active', mode === 'login');
    document.getElementById('tab-register').classList.toggle('active', mode === 'register');
    document.getElementById('auth-submit-btn').textContent = mode === 'login' ? 'ログイン' : '新規登録';
    document.getElementById('auth-msg').textContent = '';
}

async function handleAuth(e) {
    e.preventDefault();
    const username = document.getElementById('auth-username').value.trim();
    const password = document.getElementById('auth-password').value;
    const msgEl = document.getElementById('auth-msg');

    const endpoint = authMode === 'login' ? '/api/login' : '/api/register';
    try {
        const res = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });
        const data = await res.json();
        if (!res.ok) {
            msgEl.style.color = '#f87171';
            msgEl.textContent = data.error;
            return;
        }

        if (authMode === 'register') {
            msgEl.style.color = '#34d399';
            msgEl.textContent = data.message;
            switchAuthTab('login');
        } else {
            token = data.token;
            localStorage.setItem('token', token);
            initApp();
        }
    } catch (err) {
        msgEl.textContent = '通信エラーが発生しました。';
    }
}

function logout() {
    localStorage.removeItem('token');
    token = null;
    if (socket) socket.disconnect();
    showScreen('auth-screen');
}

// ================= アプリ初期化・ホーム画面 =================
async function initApp() {
    await loadUserProfile();
    await loadRankings();
    connectSocket();
    showScreen('home-screen');
}

async function loadUserProfile() {
    const res = await fetch('/api/me', {
        headers: { 'Authorization': `Bearer ${token}` }
    });
    if (!res.ok) return logout();
    currentUser = await res.json();

    document.getElementById('home-username').textContent = currentUser.username;
    const badgeEl = document.getElementById('home-rank-badge');
    badgeEl.textContent = `${currentUser.currentRank.badge} (${currentUser.rank_points}pt)`;
    badgeEl.style.border = `1px solid ${currentUser.currentRank.color}`;

    document.getElementById('stat-played').textContent = currentUser.games_played;
    document.getElementById('stat-wins').textContent = currentUser.wins;
    document.getElementById('stat-winrate').textContent = `${currentUser.winRate}%`;
    document.getElementById('stat-maxrank').textContent = currentUser.maxRank.badge;
}

async function loadRankings() {
    const res = await fetch('/api/rankings');
    if (res.ok) {
        rankingsData = await res.json();
        toggleRankingView();
    }
}

// スライダー切り替え（ランク上位 ⇔ 勝利回数）
function toggleRankingView() {
    const isWins = document.getElementById('ranking-slider').checked;
    document.getElementById('label-rank').classList.toggle('active-label', !isWins);
    document.getElementById('label-wins').classList.toggle('active-label', isWins);

    const list = isWins ? rankingsData.byWins : rankingsData.byRank;
    const ul = document.getElementById('ranking-list');
    ul.innerHTML = '';

    list.forEach((u, idx) => {
        const li = document.createElement('li');
        const rightText = isWins ? `${u.wins}勝` : `${u.rank_points} pt`;
        li.innerHTML = `
            <span><strong>#${idx + 1}</strong> ${u.username} <small class="badge">${u.rankInfo.badge}</small></span>
            <strong>${rightText}</strong>
        `;
        ul.appendChild(li);
    });
}

// ================= 設定（パスワード変更・アカウント削除） =================
function openSettings() {
    document.getElementById('setting-username').textContent = currentUser.username;
    document.getElementById('old-password').value = '';
    document.getElementById('new-password').value = '';
    hideDeleteConfirm();
    openModal('settings-modal');
}

async function changePassword() {
    const currentPassword = document.getElementById('old-password').value;
    const newPassword = document.getElementById('new-password').value;

    const res = await fetch('/api/change-password', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ currentPassword, newPassword })
    });
    const data = await res.json();
    if (!res.ok) {
        alert(data.error);
    } else {
        alert(data.message);
        closeModal('settings-modal');
        logout();
    }
}

function confirmDeleteAccount() {
    document.getElementById('delete-confirm-box').classList.remove('hidden');
}
function hideDeleteConfirm() {
    document.getElementById('delete-confirm-box').classList.add('hidden');
}

async function deleteAccount() {
    const res = await fetch('/api/account', {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` }
    });
    if (res.ok) {
        alert('アカウントおよび全データを削除しました。');
        closeModal('settings-modal');
        logout();
    } else {
        alert('削除に失敗しました。');
    }
}

// ================= Socket.io 通信・ロビー・ゲーム制御 =================
function connectSocket() {
    if (socket) socket.disconnect();
    socket = io({ auth: { token } });

    socket.on('errorMsg', (msg) => alert(msg));

    // カスタム部屋参加・更新
    socket.on('roomJoined', (room) => {
        currentRoom = room;
        closeModal('create-room-modal');
        renderLobby(room);
        showScreen('lobby-screen');
    });

    socket.on('roomUpdated', (room) => {
        currentRoom = room;
        renderLobby(room);
    });

    // ランクマッチ待機
    socket.on('searchingRanked', ({ mode, current }) => {
        document.getElementById('matching-status').textContent = `${mode}人専用ランク戦 マッチング中 (${current}/${mode}人)`;
        openModal('matching-modal');
    });

    socket.on('rankedMatched', (room) => {
        currentRoom = room;
        closeModal('matching-modal');
    });

    // カウントダウン
    socket.on('countdown', (count) => {
        showScreen('game-screen');
        const overlay = document.getElementById('countdown-overlay');
        overlay.classList.remove('hidden');
        document.getElementById('countdown-number').textContent = count;
    });

    // ゲーム開始
    socket.on('gameStarted', (data) => {
        document.getElementById('countdown-overlay').classList.add('hidden');
        document.getElementById('chat-messages').innerHTML = ''; // チャット完全リセット
        document.getElementById('game-target-num').textContent = data.targetNumber;
        document.getElementById('game-timer').textContent = data.timeLimit;
        
        currentRoom = { ...currentRoom, ...data };
        updateCountDisplay(0, data.targetNumber);
        renderGamePlayers(data.players, data.turnIndex);
        updateTurnControls(data.players[data.turnIndex].userId === currentUser.id);
    });

    // 数字更新
    socket.on('numberUpdated', ({ currentNumber, targetNumber, turnAdded }) => {
        updateCountDisplay(currentNumber, targetNumber);
        document.getElementById('turn-added-count').textContent = turnAdded;
    });

    // ターン交代
    socket.on('turnChanged', ({ turnIndex, currentNumber }) => {
        currentRoom.turnIndex = turnIndex;
        document.getElementById('turn-added-count').textContent = 0;
        renderGamePlayers(currentRoom.players, turnIndex);
        const isMyTurn = currentRoom.players[turnIndex].userId === currentUser.id;
        updateTurnControls(isMyTurn);
    });

    // タイマー更新
    socket.on('timerTick', ({ timeLeft }) => {
        document.getElementById('game-timer').textContent = timeLeft;
    });

    // チャット受信
    socket.on('chatMessage', (msg) => {
        const box = document.getElementById('chat-messages');
        const div = document.createElement('div');
        div.className = 'chat-msg' + (msg.system ? ' system' : '');
        div.textContent = msg.system ? `🔔 ${msg.text}` : `${msg.sender} [${msg.badge}]: ${msg.text}`;
        box.appendChild(div);
        box.scrollTop = box.scrollHeight;
    });

    // ゲーム終了
    socket.on('gameOver', ({ reason, results, isRanked, rankedMode }) => {
        document.getElementById('tap-circle-btn').disabled = true;
        document.getElementById('end-turn-btn').disabled = true;
        document.getElementById('your-turn-banner').classList.add('hidden');

        document.getElementById('result-reason').textContent = reason;
        const ul = document.getElementById('result-list');
        ul.innerHTML = '';

        results.forEach(r => {
            const li = document.createElement('li');
            const status = r.isWinner ? '🏆 勝利' : '💀 敗北';
            let ptText = '';
            if (isRanked && r.pointChange !== null) {
                const sign = r.pointChange >= 0 ? '+' : '';
                ptText = ` (${sign}${r.pointChange}pt → ${r.rankInfo.badge} ${r.newPoints}pt)`;
            }
            li.innerHTML = `<span>${r.username}</span><strong>${status}${ptText}</strong>`;
            ul.appendChild(li);
        });

        const rankedActions = document.getElementById('result-ranked-actions');
        const customActions = document.getElementById('result-custom-actions');

        if (isRanked) {
            lastRankedMode = rankedMode || 2;
            rankedActions.classList.remove('hidden');
            customActions.classList.add('hidden');
        } else {
            rankedActions.classList.add('hidden');
            customActions.classList.remove('hidden');
        }

        openModal('result-modal');
    });
}

// 部屋作成・参加操作
function openCreateRoomModal() { openModal('create-room-modal'); }
function setRandomTarget() {
    document.getElementById('room-target-num').value = Math.floor(Math.random() * (50 - 30 + 1)) + 30;
}
function createRoom() {
    const targetNumber = document.getElementById('room-target-num').value;
    const turnTimeLimit = document.getElementById('room-time-limit').value;
    socket.emit('createRoom', { targetNumber, turnTimeLimit });
}
function joinRoomByCode() {
    const code = document.getElementById('join-code-input').value;
    if (!code) return alert('部屋コードを入力してください');
    socket.emit('joinRoom', { code });
}

// ロビー描画・操作
function renderLobby(room) {
    document.getElementById('lobby-room-code').textContent = room.id;
    document.getElementById('lobby-target').textContent = room.targetNumber;
    document.getElementById('lobby-time').textContent = room.turnTimeLimit;

    const isHost = room.hostId === currentUser.id;

    // ホストとゲストでルール表示/編集エリアを切り替え
    document.getElementById('lobby-rules-view').classList.toggle('hidden', isHost);
    document.getElementById('lobby-rules-edit').classList.toggle('hidden', !isHost);

    if (isHost) {
        document.getElementById('lobby-edit-target').value = room.targetNumber;
        document.getElementById('lobby-edit-time').value = String(room.turnTimeLimit);
    }

    const ul = document.getElementById('lobby-player-list');
    ul.innerHTML = '';
    room.players.forEach((p, i) => {
        const li = document.createElement('li');
        const hostTag = p.userId === room.hostId ? ' 👑(ホスト)' : '';
        const readyTag = p.ready ? '✅ 準備OK' : '⏳ 待機中';
        li.innerHTML = `<span>${i + 1}. ${p.username} <small class="badge">${p.rankInfo.badge}</small>${hostTag}</span><span>${readyTag}</span>`;
        ul.appendChild(li);
    });

    document.getElementById('btn-shuffle').classList.toggle('hidden', !isHost);
    document.getElementById('host-start-controls').classList.toggle('hidden', !isHost);

    if (isHost) {
        const allReady = room.players.length >= 2 && room.players.every(p => p.ready);
        document.getElementById('btn-start-normal').disabled = !allReady;
    }
}

function setLobbyRandomTarget() {
    const rand = Math.floor(Math.random() * (50 - 30 + 1)) + 30;
    document.getElementById('lobby-edit-target').value = rand;
    updateRoomSettings();
}

function updateRoomSettings() {
    const targetNumber = document.getElementById('lobby-edit-target').value;
    const turnTimeLimit = document.getElementById('lobby-edit-time').value;
    socket.emit('updateRoomSettings', { targetNumber, turnTimeLimit });
}

function toggleReady() { socket.emit('toggleReady'); }
function shuffleOrder() { socket.emit('shuffleOrder'); }
function startCustomGame(force) { socket.emit('startCustomGame', { force }); }
function leaveLobby() {
    socket.emit('leaveLobby');
    showScreen('home-screen');
}

// ランク戦操作
function joinRanked(mode) { socket.emit('joinRanked', { mode }); }
function cancelRanked() {
    socket.emit('cancelRanked');
    closeModal('matching-modal');
}

// ゲーム中UI更新
function updateCountDisplay(current, target) {
    const el = document.getElementById('current-count-display');
    el.textContent = current;
    el.className = 'count-number';

    const ratio = current / target;
    if (ratio >= 0.85) el.classList.add('count-critical');
    else if (ratio >= 0.65) el.classList.add('count-danger');
    else if (ratio >= 0.4) el.classList.add('count-warn');
}

function renderGamePlayers(players, turnIndex) {
    const bar = document.getElementById('game-players-bar');
    bar.innerHTML = '';
    players.forEach((p, idx) => {
        const chip = document.createElement('div');
        chip.className = 'player-chip' + (idx === turnIndex ? ' active-turn' : '');
        chip.textContent = `${idx + 1}. ${p.username} (${p.rankInfo.badge})`;
        bar.appendChild(chip);
    });
}

function updateTurnControls(isMyTurn) {
    document.getElementById('tap-circle-btn').disabled = !isMyTurn;
    document.getElementById('end-turn-btn').disabled = !isMyTurn;

    const banner = document.getElementById('your-turn-banner');
    if (isMyTurn) {
        banner.classList.remove('hidden');
        setTimeout(() => banner.classList.add('hidden'), 2000);
    } else {
        banner.classList.add('hidden');
    }
}

function tapIncrement() { socket.emit('incrementNumber'); }
function endTurn() { socket.emit('endTurn'); }

function sendChat(e) {
    e.preventDefault();
    const input = document.getElementById('chat-input');
    if (input.value.trim()) {
        socket.emit('sendChat', { message: input.value });
        input.value = '';
    }
}

async function returnToHome() {
    closeModal('result-modal');
    document.getElementById('chat-messages').innerHTML = '';
    await loadUserProfile();
    await loadRankings();
    showScreen('home-screen');
}

// ランク戦：もう一度遊ぶ（即マッチング待機画面へ）
async function playRankedAgain() {
    closeModal('result-modal');
    document.getElementById('chat-messages').innerHTML = '';
    await loadUserProfile();
    joinRanked(lastRankedMode);
}

// カスタム部屋：解散せずにロビー（設定画面）へ戻る
function returnToLobbyFromResult() {
    closeModal('result-modal');
    document.getElementById('chat-messages').innerHTML = '';
    if (currentRoom) {
        renderLobby(currentRoom);
    }
    showScreen('lobby-screen');
}