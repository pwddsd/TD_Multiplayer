const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

let rooms = {};

const wordList = [
    "algorithm", "binary", "compiler", "debug", "execute", 
    "function", "gateway", "hardware", "iteration", "javascript", 
    "kernel", "logic", "macro", "network", "object", 
    "pixel", "query", "router", "syntax", "variable"
];

function getRandomWord() { return wordList[Math.floor(Math.random() * wordList.length)]; }

const mapWaypoints = [
    { col: 5, row: 55 }, { col: 30, row: 55 }, 
    { col: 30, row: 5 }, { col: 55, row: 5 }   
];

const TILE_SIZE = 10;

const unitStats = {
    "1": { cost: 1, hp: 1, speed: 3, size: 10 },
    "2": { cost: 3, hp: 4, speed: 2, size: 14 },
    "3": { cost: 5, hp: 10, speed: 1.5, size: 20 }
};

const towerStats = {
    "basic": { cost: 10, range: 100, damage: 1, cooldown: 60, type: "single" }, 
    "aoe":   { cost: 25, range: 80,  damage: 2, cooldown: 90, type: "aoe" }     
};

app.get('/', (req, res) => { res.sendFile(__dirname + '/index.html'); });

io.on('connection', (socket) => {
    socket.on('joinRoom', (data) => {
        let roomCode = data.roomCode.toUpperCase();
        let playerName = data.name || "Anonymous";

        if (!rooms[roomCode]) {
            rooms[roomCode] = {
                gameState: 'waiting', players: {}, creepers: {}, towers: [], 
                lasers: [], aoeBlasts: [], 
                bases: { 0: 10, 1: 10 }, creeperIdCounter: 0
            };
        }

        let room = rooms[roomCode];
        let pIds = Object.keys(room.players);

        if (pIds.length >= 2) return socket.emit('roomError', 'Room is full!');

        // --- BUG FIX: Smarter Team Assignment ---
        let assignedTeam = 0;
        if (pIds.length === 1) {
            // Give the new player the opposite team of whoever is already in the room
            let existingTeam = room.players[pIds[0]].team;
            assignedTeam = existingTeam === 0 ? 1 : 0;
        }

        room.players[socket.id] = {
            id: socket.id, name: playerName, team: assignedTeam, color: 'gray', 
            currentWord: getRandomWord(), points: 0, isReady: false
        };

        socket.roomCode = roomCode;
        socket.join(roomCode);
        socket.emit('roomJoined', { roomCode: roomCode });
        socket.emit('initMap', { waypoints: mapWaypoints });
        io.to(roomCode).emit('lobbyUpdate', room.players); 
    });

    socket.on('playerReady', (data) => {
        let roomCode = socket.roomCode;
        if (!roomCode || !rooms[roomCode]) return;
        let room = rooms[roomCode];
        if (room.players[socket.id]) {
            let requestedColor = data.color;
            let colorTaken = Object.values(room.players).some(p => p.id !== socket.id && p.isReady && p.color === requestedColor);
            if (colorTaken) {
                let allColors = ['blue', 'red', 'green', 'purple', 'orange', 'hotpink'];
                let usedColors = Object.values(room.players).filter(p => p.isReady).map(p => p.color);
                requestedColor = allColors.find(c => !usedColors.includes(c)) || 'gray';
            }
            room.players[socket.id].color = requestedColor; 
            room.players[socket.id].isReady = true;
            io.to(roomCode).emit('lobbyUpdate', room.players);

            let pIds = Object.keys(room.players);
            if (pIds.length >= 2 && pIds.every(id => room.players[id].isReady)) {
                room.gameState = 'playing';
                io.to(roomCode).emit('gameStart');
                for (let id in room.players) io.to(id).emit('newWord', room.players[id].currentWord);
            }
        }
    });

    socket.on('placeTower', (data) => {
        let roomCode = socket.roomCode;
        if (!roomCode || !rooms[roomCode]) return;
        let room = rooms[roomCode];
        if (room.gameState !== 'playing') return; 
        let p = room.players[socket.id];
        if (!p) return;

        let stats = towerStats[data.towerType];
        if (!stats) return;

        if (p.points >= stats.cost) {
            let isLeftTeam = p.team === 0;
            let validSide = isLeftTeam ? data.x < 300 : data.x > 300;

            if (validSide) {
                p.points -= stats.cost;
                room.towers.push({
                    owner: socket.id, team: p.team, color: p.color,
                    x: data.x, y: data.y,
                    range: stats.range, damage: stats.damage, 
                    cooldown: stats.cooldown, timer: 0, type: stats.type
                });
            }
        }
    });

    socket.on('submitWord', (typedWord) => {
        let roomCode = socket.roomCode;
        if (!roomCode || !rooms[roomCode]) return;
        let room = rooms[roomCode];
        if (room.gameState !== 'playing') return; 
        let p = room.players[socket.id];
        if (!p) return;

        if (unitStats[typedWord]) {
            let stats = unitStats[typedWord];
            if (p.points >= stats.cost) {
                p.points -= stats.cost; 
                let startWpIndex = p.team === 0 ? 0 : 3;
                let nextWpIndex = p.team === 0 ? 1 : 2;
                let direction = p.team === 0 ? 1 : -1;
                let startX = mapWaypoints[startWpIndex].col * TILE_SIZE + (TILE_SIZE / 2);
                let startY = mapWaypoints[startWpIndex].row * TILE_SIZE + (TILE_SIZE / 2);

                room.creepers[room.creeperIdCounter++] = {
                    owner: socket.id, team: p.team, color: p.color, x: startX, y: startY,
                    targetIndex: nextWpIndex, direction: direction, hp: stats.hp, speed: stats.speed, size: stats.size
                };
            }
        } 
        else if (typedWord.toLowerCase() === p.currentWord.toLowerCase()) {
            p.points += 1; 
            p.currentWord = getRandomWord();
            socket.emit('newWord', p.currentWord);
        }
    });

    socket.on('disconnect', () => {
        let roomCode = socket.roomCode;
        if (roomCode && rooms[roomCode]) {
            delete rooms[roomCode].players[socket.id];
            if (Object.keys(rooms[roomCode].players).length === 0) delete rooms[roomCode];
            else io.to(roomCode).emit('lobbyUpdate', rooms[roomCode].players);
        }
    });
});

setInterval(() => {
    for (let roomCode in rooms) {
        let room = rooms[roomCode];
        if (room.gameState !== 'playing') continue; 

        room.lasers = [];
        room.aoeBlasts.forEach(b => b.life--);
        room.aoeBlasts = room.aoeBlasts.filter(b => b.life > 0); 

        room.towers.forEach(tower => {
            if (tower.timer > 0) tower.timer--; 
            
            if (tower.timer === 0) {
                if (tower.type === 'single') {
                    let targetId = null, closestDist = tower.range;
                    for (let cid in room.creepers) {
                        let c = room.creepers[cid];
                        if (c.team !== tower.team) {
                            let dist = Math.hypot(c.x - tower.x, c.y - tower.y);
                            if (dist < closestDist) { closestDist = dist; targetId = cid; }
                        }
                    }
                    if (targetId) {
                        let target = room.creepers[targetId];
                        target.hp -= tower.damage;
                        tower.timer = tower.cooldown;
                        room.lasers.push({ startX: tower.x, startY: tower.y, endX: target.x, endY: target.y, color: tower.color });
                        
                        if (target.hp <= 0) {
                            delete room.creepers[targetId];
                            if (room.players[tower.owner]) room.players[tower.owner].points += 1;
                        }
                    }
                } 
                else if (tower.type === 'aoe') {
                    let hitSomething = false;
                    for (let cid in room.creepers) {
                        let c = room.creepers[cid];
                        if (c.team !== tower.team) {
                            let dist = Math.hypot(c.x - tower.x, c.y - tower.y);
                            if (dist <= tower.range) {
                                hitSomething = true;
                                c.hp -= tower.damage;
                                if (c.hp <= 0) {
                                    delete room.creepers[cid];
                                    if (room.players[tower.owner]) room.players[tower.owner].points += 1;
                                }
                            }
                        }
                    }
                    if (hitSomething) {
                        tower.timer = tower.cooldown;
                        room.aoeBlasts.push({ x: tower.x, y: tower.y, range: tower.range, color: tower.color, life: 15 });
                    }
                }
            }
        });

        for (let id in room.creepers) {
            let c = room.creepers[id];
            let targetWp = mapWaypoints[c.targetIndex];

            if (!targetWp) {
                let enemyTeam = c.team === 0 ? 1 : 0;
                room.bases[enemyTeam] -= c.hp; 
                
                // --- NEW: CREEPER BOUNTY ---
                // Give owner points equal to the exact damage they did to the base!
                if (room.players[c.owner]) {
                    room.players[c.owner].points += c.hp; 
                }

                delete room.creepers[id]; 

                if (room.bases[enemyTeam] <= 0) {
                    let winnerName = room.players[c.owner] ? room.players[c.owner].name : "Someone";
                    io.to(roomCode).emit('gameOver', { winner: winnerName });
                    
                    room.bases = { 0: 10, 1: 10 }; room.creepers = {}; room.towers = []; room.lasers = []; room.aoeBlasts = [];
                    room.gameState = 'waiting';
                    for(let pid in room.players) { room.players[pid].points = 0; room.players[pid].isReady = false; }
                    io.to(roomCode).emit('lobbyUpdate', room.players);
                    break; 
                }
                continue; 
            }

            let targetX = targetWp.col * TILE_SIZE + (TILE_SIZE / 2);
            let targetY = targetWp.row * TILE_SIZE + (TILE_SIZE / 2);
            if (c.x < targetX) c.x += Math.min(c.speed, targetX - c.x); else if (c.x > targetX) c.x -= Math.min(c.speed, c.x - targetX);
            if (c.y < targetY) c.y += Math.min(c.speed, targetY - c.y); else if (c.y > targetY) c.y -= Math.min(c.speed, c.y - targetY);
            if (c.x === targetX && c.y === targetY) c.targetIndex += c.direction; 
        }

        let creeperIds = Object.keys(room.creepers);
        for (let i = 0; i < creeperIds.length; i++) {
            for (let j = i + 1; j < creeperIds.length; j++) {
                let c1 = room.creepers[creeperIds[i]]; let c2 = room.creepers[creeperIds[j]];
                if (c1 && c2 && c1.team !== c2.team) {
                    let distance = Math.hypot(c1.x - c2.x, c1.y - c2.y);
                    let hitDistance = (c1.size + c2.size) / 2;
                    if (distance < hitDistance) {
                        let c1Damage = c1.hp; let c2Damage = c2.hp;
                        c1.hp -= c2Damage; c2.hp -= c1Damage;
                        if (c1.hp <= 0) delete room.creepers[creeperIds[i]]; if (c2.hp <= 0) delete room.creepers[creeperIds[j]];
                    }
                }
            }
        }

        io.to(roomCode).emit('stateUpdate', { 
            creepers: room.creepers, towers: room.towers, lasers: room.lasers, aoeBlasts: room.aoeBlasts, bases: room.bases, players: room.players 
        });
    }
}, 1000 / 30); 

server.listen(80, '0.0.0.0', () => { console.log('Running!'); });
//server.listen(3000, () => { console.log('Game server running on http://localhost:3000'); });