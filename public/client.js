const socket = io();

// Áudio Setup
const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
function playTone(freq, type, dur) {
    if(audioCtx.state === 'suspended') audioCtx.resume();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = type; osc.frequency.value = freq;
    osc.connect(gain); gain.connect(audioCtx.destination);
    osc.start(); gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + dur);
    osc.stop(audioCtx.currentTime + dur);
}
const sfx = {
    click: () => playTone(600, 'sine', 0.05),
    connect: () => playTone(400, 'triangle', 0.1),
    good: () => { playTone(500, 'sine', 0.1); setTimeout(()=>playTone(800, 'sine', 0.2), 100); },
    bad: () => { playTone(150, 'sawtooth', 0.2); setTimeout(()=>playTone(100, 'sawtooth', 0.2), 150); },
    win: () => [300,500,700].forEach((f,i) => setTimeout(()=>playTone(f,'square',0.1), i*100))
};

// Referências
const dom = {
    lobby: document.getElementById('lobby-screen'),
    game: document.getElementById('game-screen'),
    result: document.getElementById('result-screen'),
    playerList: document.getElementById('player-area'),
    btnReady: document.getElementById('btn-ready'),
    btnRestart: document.getElementById('btn-restart'),
    board: document.getElementById('board'),
    drawingLayer: document.getElementById('drawing-layer'), // SVG
    timer: document.getElementById('timer'),
    preview: document.getElementById('word-preview'),
    foundCount: document.getElementById('count-found'),
    feedback: document.getElementById('feedback-msg')
};

let state = {
    myId: null,
    dragging: false,
    selection: [],
    found: new Set(),
    lastInteract: Date.now(),
    hintTimer: null,
    showingHint: false // Flag para saber se tem dica na tela
};

// === SOCKET EVENTS ===
socket.on('connect', () => { state.myId = socket.id; });

socket.on('updatePlayers', (players) => {
    const list = Object.values(players);
    dom.playerList.innerHTML = list.map(p => `
        <div class="player-row ${p.ready?'ready':''}">
            <span>${p.avatar} ${p.id === state.myId ? 'VOCÊ' : 'ELA(E)'}</span>
            <span>${p.ready ? '✅' : '⏳'}</span>
        </div>
    `).join('');

    const me = players[state.myId];
    if (me?.ready) {
        dom.btnReady.innerText = "AGUARDANDO...";
        dom.btnReady.disabled = true;
    } else {
        dom.btnReady.innerText = "ESTOU PRONTO! 🚀";
        dom.btnReady.disabled = false;
    }
});

socket.on('gameStart', ({ board }) => {
    showScreen('game');
    renderBoard(board);
    state.found.clear();
    dom.foundCount.innerText = '0';
    dom.preview.innerText = '';
    clearHint();
    startHintCheck();
});

socket.on('tick', (t) => {
    let m = Math.floor(t/60), s = t%60;
    dom.timer.innerText = `0${m}:${s<10?'0'+s:s}`;
    dom.timer.className = t <= 10 ? 'timer alert' : 'timer';
});

socket.on('timeUp', () => {
    socket.emit('submitWords', Array.from(state.found));
    dom.timer.innerText = "FIM!";
});

socket.on('gameOver', (res) => {
    showScreen('result');
    animateResults(res);
});

socket.on('resetGame', () => {
    state.selection = [];
    state.dragging = false;
    showScreen('lobby');
});

socket.on('opponentLeft', () => {
    alert("O oponente saiu!");
    showScreen('lobby');
});

// === DICA VISUAL ===
socket.on('hintData', ({ word, path }) => {
    clearHint();
    state.showingHint = true;
    dom.preview.innerText = `DICA: ${word}`;
    dom.preview.style.color = '#ffa502';
    drawPath(path, 'hint-line'); // Desenha linha amarela
    
    // Ilumina dados
    path.forEach(idx => {
        const el = document.querySelector(`.die[data-index="${idx}"]`);
        if(el) el.classList.add('hint-highlight');
    });
    // NÃO TEM SETTIMEOUT MAIS! Fica até o usuário tocar.
});

function clearHint() {
    state.showingHint = false;
    dom.drawingLayer.innerHTML = '';
    document.querySelectorAll('.die').forEach(d => d.classList.remove('hint-highlight'));
    dom.preview.style.color = '#ff6b6b';
    if(!state.selection.length) dom.preview.innerText = '';
}

// === DESENHO DA LINHA ===
function drawPath(indices, cssClass) {
    let svgHTML = '';
    const wrapperRect = dom.drawingLayer.getBoundingClientRect();

    for(let i=0; i<indices.length-1; i++) {
        const idxA = indices[i];
        const idxB = indices[i+1];
        const elA = document.querySelector(`.die[data-index="${idxA}"]`);
        const elB = document.querySelector(`.die[data-index="${idxB}"]`);
        
        if(elA && elB) {
            const rectA = elA.getBoundingClientRect();
            const rectB = elB.getBoundingClientRect();

            // Centro dos dados
            const x1 = (rectA.left + rectA.width/2) - wrapperRect.left;
            const y1 = (rectA.top + rectA.height/2) - wrapperRect.top;
            const x2 = (rectB.left + rectB.width/2) - wrapperRect.left;
            const y2 = (rectB.top + rectB.height/2) - wrapperRect.top;

            svgHTML += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" class="${cssClass}" />`;
        }
    }
    dom.drawingLayer.innerHTML = svgHTML;
}

// === GAMEPLAY ===
dom.btnReady.addEventListener('click', () => { sfx.click(); socket.emit('playerReady'); });
dom.btnRestart.addEventListener('click', () => { sfx.click(); socket.emit('restartRequest'); });

function renderBoard(board) {
    dom.board.innerHTML = '';
    board.forEach((char, i) => {
        const d = document.createElement('div');
        d.className = 'die';
        d.innerText = char;
        d.dataset.index = i;
        dom.board.appendChild(d);
    });
}

const area = document.getElementById('game-screen');
area.addEventListener('mousedown', startDrag);
area.addEventListener('touchstart', startDrag, {passive: false});
window.addEventListener('mousemove', drag);
window.addEventListener('touchmove', drag, {passive: false});
window.addEventListener('mouseup', endDrag);
window.addEventListener('touchend', endDrag);

function startDrag(e) {
    const el = getTarget(e);
    if(el?.classList.contains('die')) {
        e.preventDefault();
        // SE TIVER DICA NA TELA, LIMPA AGORA!
        if(state.showingHint) clearHint();

        state.dragging = true;
        state.selection = [];
        addSelection(el);
        resetInteract();
    }
}

function drag(e) {
    if(!state.dragging) return;
    e.preventDefault();
    const el = getTarget(e);
    if(el?.classList.contains('die')) {
        const idx = parseInt(el.dataset.index);
        const lastIdx = state.selection[state.selection.length-1];

        // Backtrack
        if(state.selection.length > 1 && state.selection[state.selection.length-2] === idx) {
            removeLastSelection();
            return;
        }
        
        // Add
        if(!state.selection.includes(idx) && isNeighbor(lastIdx, idx)) {
            addSelection(el);
            resetInteract();
        }
    }
}

function endDrag() {
    if(!state.dragging) return;
    state.dragging = false;
    dom.drawingLayer.innerHTML = ''; // Limpa a linha do usuário ao soltar

    const word = dom.preview.innerText;
    if(word.length >= 3 && !state.found.has(word)) {
        socket.emit('checkWord', word, (valid) => {
            if(valid) {
                state.found.add(word);
                dom.foundCount.innerText = state.found.size;
                showFeedback('BOA! 👍', '#2ecc71');
                sfx.good();
                if(word.length >= 6) confetti({ origin: { y: 0.7 } });
            } else {
                showFeedback('NÃO EXISTE', '#ff7675');
                sfx.bad();
            }
        });
    } else if (state.found.has(word)) {
        showFeedback('JÁ FOI!', '#ffeaa7');
        sfx.bad();
    }

    state.selection = [];
    document.querySelectorAll('.die').forEach(d => d.classList.remove('selected'));
    dom.preview.innerText = '';
}

function getTarget(e) {
    const t = e.touches ? e.touches[0] : e;
    return document.elementFromPoint(t.clientX, t.clientY);
}

function addSelection(el) {
    el.classList.add('selected');
    state.selection.push(parseInt(el.dataset.index));
    dom.preview.innerText = state.selection.map(i => document.querySelector(`.die[data-index="${i}"]`).innerText).join('');
    sfx.connect();
    // Desenha a linha do usuário (Turquesa)
    drawPath(state.selection, 'user-line');
}

function removeLastSelection() {
    const idx = state.selection.pop();
    document.querySelector(`.die[data-index="${idx}"]`).classList.remove('selected');
    dom.preview.innerText = state.selection.map(i => document.querySelector(`.die[data-index="${i}"]`).innerText).join('');
    sfx.click();
    drawPath(state.selection, 'user-line');
}

function isNeighbor(i1, i2) {
    const r1 = Math.floor(i1/4), c1 = i1%4;
    const r2 = Math.floor(i2/4), c2 = i2%4;
    return Math.abs(r1-r2) <= 1 && Math.abs(c1-c2) <= 1;
}

// === UTILS ===
function showScreen(id) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.getElementById(id+'-screen').classList.add('active');
}
function showFeedback(txt, color) {
    dom.feedback.innerText = txt;
    dom.feedback.style.color = color;
    dom.feedback.style.opacity = 1;
    dom.feedback.style.transform = 'translate(-50%, -20px)';
    setTimeout(() => {
        dom.feedback.style.opacity = 0;
        dom.feedback.style.transform = 'translate(-50%, 0)';
    }, 1000);
}
function startHintCheck() {
    if(state.hintTimer) clearInterval(state.hintTimer);
    state.hintTimer = setInterval(() => {
        // 30 SEGUNDOS de inatividade e não estar arrastando
        if(Date.now() - state.lastInteract > 30000 && !state.dragging && !state.showingHint) {
            socket.emit('requestHint', Array.from(state.found));
            state.lastInteract = Date.now();
        }
    }, 1000);
}
function resetInteract() { state.lastInteract = Date.now(); }

// ANIMATION
async function animateResults(res) {
    sfx.win();
    const myRes = res.players[state.myId];
    const oppId = Object.keys(res.players).find(id => id !== state.myId);
    const oppRes = res.players[oppId];

    dom.btnRestart.style.display = 'none';
    document.getElementById('word-stream').innerHTML = '';
    
    // Zera barras
    document.getElementById('p1-bar').style.height = '0%';
    document.getElementById('p2-bar').style.height = '0%';
    document.getElementById('p1-score-txt').innerText = '0';
    document.getElementById('p2-score-txt').innerText = '0';

    let queue = [];
    // Owner 1 = EU (Sempre), Owner 2 = Oponente
    myRes.details.forEach(w => queue.push({...w, owner: 1}));
    if(oppRes) oppRes.details.forEach(w => queue.push({...w, owner: 2}));
    queue.sort(() => Math.random() - 0.5);

    let s1 = 0, s2 = 0;
    const max = Math.max(myRes.score, oppRes?.score || 10) * 1.1;

    for (let item of queue) {
        await new Promise(r => setTimeout(r, 400));
        const div = document.createElement('div');
        div.className = `res-pill ${item.unique ? 'unique' : ''}`;
        // Cor baseada se sou EU (1) ou ELA (2)
        div.style.backgroundColor = item.owner === 1 ? 'var(--primary)' : 'var(--secondary)';
        div.innerText = `${item.word} +${item.pts}`;
        document.getElementById('word-stream').appendChild(div);
        
        if(item.owner === 1) s1 += item.pts; else s2 += item.pts;
        document.getElementById('p1-score-txt').innerText = s1;
        document.getElementById('p2-score-txt').innerText = s2;
        document.getElementById('p1-bar').style.height = (s1/max*100)+'%';
        document.getElementById('p2-bar').style.height = (s2/max*100)+'%';
        
        if(item.unique) sfx.good(); else sfx.click();
    }
    
    document.getElementById('missed-words').innerHTML = res.missed.map(w => `<span class="missed-word">${w}</span>`).join('');
    dom.btnRestart.style.display = 'block';
}