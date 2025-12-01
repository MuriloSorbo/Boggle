const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

// === 1. DICIONÁRIO ===
let DICTIONARY = new Set();
const DICT_PATH = path.join(__dirname, 'wordlist.txt');

function loadDictionary() {
    try {
        if (fs.existsSync(DICT_PATH)) {
            const data = fs.readFileSync(DICT_PATH, 'utf8');
            const words = data.split(/\r?\n/);
            words.forEach(w => {
                const clean = w.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase().trim();
                if (clean.length >= 3) DICTIONARY.add(clean);
            });
            console.log(`📚 Dicionário: ${DICTIONARY.size} palavras.`);
        } else {
            console.log("⚠️ Usando dicionário de backup.");
            const fallback = ["AMOR", "CASA", "BOLA", "GATO", "DADO", "FACA", "JOGO", "VIDA", "ARTE", "CAFE", "TESTE", "CODIGO", "COMPUTADOR", "CELULAR", "MOUSE", "TECLADO", "BRASIL", "NAMORADA", "FESTA", "NOITE", "DIA", "QUEIJO", "BANANA", "UVA"];
            fallback.forEach(w => DICTIONARY.add(w));
        }
    } catch (e) { console.error(e); }
}
loadDictionary();

// === 2. LÓGICA DO JOGO ===
const DICE_FACES = [
    "AAEEGN", "ABBJOO", "ACHOPS", "AFFKPS",
    "AOOTTW", "CIMOTU", "DEILRX", "DELRVY",
    "DISTTY", "EEGHNW", "EEINSU", "EHRTVW",
    "EIOSST", "ELRTTY", "HIMNQU", "HLNNRZ"
];

let gameState = {
    players: {},
    board: [],
    possibleWords: [],
    gameActive: false,
    timer: 120 // <--- MUDADO PARA 90 SEGUNDOS
};

function shuffleBoard() {
    let board = [];
    let shuffledDice = [...DICE_FACES].sort(() => 0.5 - Math.random());
    for (let die of shuffledDice) {
        let char = die[Math.floor(Math.random() * 6)];
        if (char === 'Q') char = 'QU';
        board.push(char);
    }
    return board;
}

function solveBoard(board) {
    let found = new Set();
    let visited = new Array(16).fill(false);
    
    function search(idx, currentWord) {
        visited[idx] = true;
        const newWord = currentWord + board[idx];
        if (newWord.length >= 3 && DICTIONARY.has(newWord)) found.add(newWord);
        if (newWord.length < 8) {
            const r = Math.floor(idx / 4), c = idx % 4;
            for (let dr = -1; dr <= 1; dr++) {
                for (let dc = -1; dc <= 1; dc++) {
                    if (dr === 0 && dc === 0) continue;
                    const nr = r + dr, nc = c + dc;
                    if (nr >= 0 && nr < 4 && nc >= 0 && nc < 4) {
                        const nIdx = nr * 4 + nc;
                        if (!visited[nIdx]) search(nIdx, newWord);
                    }
                }
            }
        }
        visited[idx] = false;
    }
    for (let i = 0; i < 16; i++) search(i, "");
    return Array.from(found).sort((a, b) => b.length - a.length);
}

function findPath(board, word) {
    let resultPath = null;
    let visited = new Array(16).fill(false);
    function searchPath(idx, currentStr, currentPath) {
        if (resultPath) return;
        visited[idx] = true;
        currentPath.push(idx);
        const newStr = currentStr + board[idx];
        if (newStr === word) { resultPath = [...currentPath]; return; }
        if (word.startsWith(newStr)) {
            const r = Math.floor(idx / 4), c = idx % 4;
            for (let dr = -1; dr <= 1; dr++) {
                for (let dc = -1; dc <= 1; dc++) {
                    if (dr === 0 && dc === 0) continue;
                    const nr = r + dr, nc = c + dc;
                    if (nr >= 0 && nr < 4 && nc >= 0 && nc < 4) {
                        const nIdx = nr * 4 + nc;
                        if (!visited[nIdx]) searchPath(nIdx, newStr, currentPath);
                    }
                }
            }
        }
        visited[idx] = false;
        currentPath.pop();
    }
    for (let i = 0; i < 16; i++) {
        if (word.startsWith(board[i])) searchPath(i, "", []);
    }
    return resultPath;
}

// === 3. SOCKET SERVER ===
io.on('connection', (socket) => {
    console.log(`Player connected: ${socket.id}`);
    if (Object.keys(gameState.players).length < 2) {
        gameState.players[socket.id] = {
            id: socket.id, ready: false, score: 0, wordsFound: [], finished: false,
            avatar: Object.keys(gameState.players).length === 0 ? "🦁" : "🐯"
        };
    } else {
        socket.emit('full', 'Sala cheia!'); return;
    }
    io.emit('updatePlayers', gameState.players);

    socket.on('playerReady', () => {
        if (gameState.players[socket.id]) {
            gameState.players[socket.id].ready = true;
            io.emit('updatePlayers', gameState.players);
            const allReady = Object.values(gameState.players).length === 2 && 
                             Object.values(gameState.players).every(p => p.ready);
            if (allReady) startGame();
        }
    });

    socket.on('checkWord', (word, callback) => callback(DICTIONARY.has(word)));

    socket.on('submitWords', (words) => {
        if (!gameState.players[socket.id]) return;
        gameState.players[socket.id].wordsFound = words.filter(w => DICTIONARY.has(w));
        gameState.players[socket.id].finished = true;
        checkRoundEnd();
    });

    socket.on('requestHint', (currentWords) => {
        const available = gameState.possibleWords.filter(w => !currentWords.includes(w));
        if (available.length > 0) {
            const word = available[Math.floor(Math.random() * Math.min(10, available.length))];
            const path = findPath(gameState.board, word);
            if (path) socket.emit('hintData', { word, path });
        }
    });

    socket.on('restartRequest', () => resetGame());

    socket.on('disconnect', () => {
        delete gameState.players[socket.id];
        if (gameState.gameActive) { resetGame(); io.emit('opponentLeft'); }
        io.emit('updatePlayers', gameState.players);
    });
});

function startGame() {
    gameState.gameActive = true;
    gameState.timer = 90; // Timer resetado
    gameState.board = shuffleBoard();
    gameState.possibleWords = solveBoard(gameState.board);
    Object.values(gameState.players).forEach(p => { p.finished = false; p.wordsFound = []; p.score = 0; });
    io.emit('gameStart', { board: gameState.board });

    let timerInt = setInterval(() => {
        if (!gameState.gameActive) { clearInterval(timerInt); return; }
        gameState.timer--;
        io.emit('tick', gameState.timer);
        if (gameState.timer <= 0) { clearInterval(timerInt); io.emit('timeUp'); }
    }, 1000);
}

function checkRoundEnd() {
    if (Object.values(gameState.players).every(p => p.finished)) calculateResults();
}

function calculateResults() {
    gameState.gameActive = false;
    let results = { players: {}, missed: [] };
    let allFound = new Set();
    const ids = Object.keys(gameState.players);
    ids.forEach(id => {
        const me = gameState.players[id];
        const opp = gameState.players[ids.find(i => i !== id)];
        let total = 0, details = [];
        me.wordsFound.forEach(w => {
            allFound.add(w);
            let pts = w.length <= 4 ? 1 : w.length === 5 ? 2 : w.length === 6 ? 3 : w.length === 7 ? 5 : 11;
            if (w.length < 3) pts = 0;
            const unique = opp ? !opp.wordsFound.includes(w) : true;
            if (unique) pts *= 2;
            total += pts;
            details.push({ word: w, pts, unique });
        });
        results.players[id] = { score: total, details };
    });
    results.missed = gameState.possibleWords.filter(w => !allFound.has(w)).slice(0, 15);
    io.emit('gameOver', results);
}

function resetGame() {
    gameState.gameActive = false;
    Object.values(gameState.players).forEach(p => { p.ready = false; p.finished = false; p.wordsFound = []; p.score = 0; });
    io.emit('resetGame');
    io.emit('updatePlayers', gameState.players);
}

server.listen(3000, () => console.log('🔥 SERVER ON: http://localhost:3000'));