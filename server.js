const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const http = require('http');

const port = 3000;
let server;
let wss;

const messageCounter = new Map();
const messageCounterStartTime = new Map();
const MAX_MESSAGES_PER_MINUTE = 200;
let activeConnections = 0;
const MAX_CONNECTIONS = 200;


const DB_DIR = path.join(__dirname, 'db');
const USERS_FILE = path.join(DB_DIR, 'users.json');

if (!fs.existsSync(DB_DIR)) {
  fs.mkdirSync(DB_DIR);
}

if (!fs.existsSync(USERS_FILE)) {
  fs.writeFileSync(USERS_FILE, JSON.stringify({}));
}


const connectionRooms = new Map();
const userConnections = new Map();
const clients = new Map();
const lastRoomBroadcastTime = new Map();


server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('SocketMod WebSocket server running');
});


wss = new WebSocket.Server({ server });

server.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
  console.log(`WebSocket endpoint: ws://localhost:${port}`);
});


function loadUsers() {
  try {
    const data = fs.readFileSync(USERS_FILE);
    return JSON.parse(data);
  } catch (error) {
    console.error('Error loading users database:', error);
    return {};
  }
}

function saveUsers(users) {
  try {
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
  } catch (error) {
    console.error('Error saving users database:', error);
  }
}

function getUser(username) {
  const users = loadUsers();
  return users[username];
}

function updateUser(username, data) {
  const users = loadUsers();

  if (!users[username]) {
    users[username] = {
      username,
      preferences: {
        color: 'rgb(255, 255, 255)'
      },
      createdAt: new Date().toISOString()
    };
  }

  if (data) {
    users[username] = { ...users[username], ...data };
  }

  saveUsers(users);
  return users[username];
}


function sendRoomColorData(ws, roomName) {
  if (!roomName || roomName === 'NaN') return;

  const roomColorData = {};
  const users = loadUsers();


  const usersInRoom = getUsersInRoom(roomName);


  for (const username of usersInRoom) {

    if (users[username]?.preferences?.color) {
      roomColorData[username] = users[username].preferences.color;
    } else {

      roomColorData[username] = 'rgb(255, 255, 255)';


      updateUser(username, {
        preferences: { color: 'rgb(255, 255, 255)' }
      });
    }
  }


  if (ws.readyState === WebSocket.OPEN) {
    console.log(`Sending color data to ${ws.currentUser} (conn: ${ws.connectionId.substr(0, 6)}) for room ${roomName}: ${Object.keys(roomColorData).join(', ')}`);
    ws.send(JSON.stringify({
      type: 'roomColorSync',
      room: roomName,
      colorData: roomColorData
    }));
  }
}

function handleUpdateRoomStatus(ws, data) {
  if (!ws.currentUser) return;
  const { room } = data;

  if (typeof room === 'string') {
    const oldRoom = connectionRooms.get(ws.connectionId);


    if (oldRoom !== room) {

      connectionRooms.set(ws.connectionId, room);


      if (!userConnections.has(ws.currentUser)) {
        userConnections.set(ws.currentUser, new Set());
      }
      userConnections.get(ws.currentUser).add(ws.connectionId);

      if (oldRoom) {
        const userStillInRoom = Array.from(userConnections.get(ws.currentUser) || [])
          .some(connId => connId !== ws.connectionId && connectionRooms.get(connId) === oldRoom);

        if (!userStillInRoom) {
          broadcastUserLeftRoom(ws.currentUser, oldRoom);
        }
      }


      sendRoomColorData(ws, room);


      broadcastRoomColorData(room);

      console.log(`User ${ws.currentUser} (connection: ${ws.connectionId.substr(0, 6)}) joined room ${room}`);
      console.log(`Current room users: ${getUsersInRoom(room).join(', ')}`);
    } else {


      sendRoomColorData(ws, room);
    }
  }
}

function broadcastRoomColorData(roomName) {
  if (!roomName || roomName === 'NaN') return;

  const now = Date.now();
  const lastBroadcast = lastRoomBroadcastTime.get(roomName) || 0;

  if (now - lastBroadcast < 2000) {
    return;
  }

  lastRoomBroadcastTime.set(roomName, now);

  const usersInRoom = getUsersInRoom(roomName);
  console.log(`Broadcasting colors to room ${roomName} with users: ${usersInRoom.join(', ')}`);

  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN &&
      client.currentUser &&
      connectionRooms.get(client.connectionId) === roomName) {
      sendRoomColorData(client, roomName);
    }
  });
}


function getUsersInRoom(roomName) {
  const users = new Set();

  for (const [connId, room] of connectionRooms.entries()) {
    if (room === roomName) {

      for (const [username, connections] of userConnections.entries()) {
        if (connections.has(connId)) {
          users.add(username);
          break;
        }
      }
    }
  }

  return Array.from(users);
}


function broadcastUserLeftRoom(username, room) {
  if (!room || room === 'NaN') return;

  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN &&
      client.currentUser !== username &&
      connectionRooms.get(client.connectionId) === room) {
      client.send(JSON.stringify({
        type: 'userLeftRoom',
        username: username
      }));
    }
  });
}


wss.on('connection', function connection(ws) {

  if (activeConnections >= MAX_CONNECTIONS) {
    console.log(`Connection limit reached (${MAX_CONNECTIONS}). Rejecting new connection.`);
    ws.close(1013, "Maximum number of connections reached");
    return;
  }


  activeConnections++;


  ws.connectionId = Date.now() + Math.random().toString(36).substr(2, 9);
  console.log(`Client connected with connection ID: ${ws.connectionId.substr(0, 6)}`);
  ws.isAlive = true;


  ws.on('pong', function () {
    this.isAlive = true;
  });


  ws.on('message', function incoming(message) {
    try {

      const now = Date.now();
      if (!messageCounterStartTime.has(ws.connectionId)) {
        messageCounterStartTime.set(ws.connectionId, now);
        messageCounter.set(ws.connectionId, 1);
      } else {
        const startTime = messageCounterStartTime.get(ws.connectionId);


        if (now - startTime > 60000) {
          messageCounterStartTime.set(ws.connectionId, now);
          messageCounter.set(ws.connectionId, 1);
        } else {

          const count = messageCounter.get(ws.connectionId) + 1;
          messageCounter.set(ws.connectionId, count);


          if (count > MAX_MESSAGES_PER_MINUTE) {
            console.log(`Client ${ws.connectionId.substr(0, 6)} exceeded message limit. Disconnecting.`);
            return ws.terminate();
          }
        }
      }


      if (message.toString().length > 1000) {
        console.log(`Message too long from ${ws.connectionId.substr(0, 6)}. Ignoring.`);
        return;
      }

      const data = JSON.parse(message.toString());
      console.log(`Received from ${ws.connectionId.substr(0, 6)}: ${message.toString()}`);

      switch (data.type) {
        case 'login':
          handleLogin(ws, data);
          break;

        case 'pong':
          handlePong(ws, data);
          break;

        case 'updateRoomStatus':
          handleUpdateRoomStatus(ws, data);
          break;

        case 'setPreference':
          handleSetPreference(ws, data);
          break;

        default:
          console.log(`Unknown message type: ${data.type}`);
      }
    } catch (error) {
      console.error('Error processing message:', error);
    }
  });


  ws.on('close', function () {
    console.log(`Client disconnected: ${ws.connectionId.substr(0, 6)}`);

    activeConnections--;

    if (ws.currentUser) {
      const room = connectionRooms.get(ws.connectionId);


      connectionRooms.delete(ws.connectionId);


      if (userConnections.has(ws.currentUser)) {
        userConnections.get(ws.currentUser).delete(ws.connectionId);


        if (userConnections.get(ws.currentUser).size === 0) {
          userConnections.delete(ws.currentUser);
          clients.delete(ws.currentUser);
        }
      }


      if (room) {
        const userStillInRoom = Array.from(userConnections.get(ws.currentUser) || [])
          .some(connId => connectionRooms.get(connId) === room);

        if (!userStillInRoom) {
          broadcastUserLeftRoom(ws.currentUser, room);
        }
      }
    }
  });


  function handleLogin(ws, data) {
    const { username } = data;

    if (!username || typeof username !== 'string' || username.trim() === '') {
      return sendError(ws, 'Invalid username');
    }

    ws.currentUser = username;
    clients.set(username, ws);


    if (!userConnections.has(username)) {
      userConnections.set(username, new Set());
    }
    userConnections.get(username).add(ws.connectionId);


    const user = updateUser(username);


    ws.send(JSON.stringify({
      type: 'loginSuccess',
      username: username,
      preferences: user.preferences
    }));
  }


function handleSetPreference(ws, data) {
  if (!ws.currentUser) return sendError(ws, 'Not logged in');

  const { key, value } = data;
  if (key !== 'color') return sendError(ws, 'Only color preference is supported');

  const user = getUser(ws.currentUser);
  if (!user) return sendError(ws, 'User not found');

  if (!user.preferences) {
    user.preferences = {};
  }

  // Store the previous color for debugging
  const oldColor = user.preferences[key];
  
  // Update the user color
  user.preferences[key] = value;
  updateUser(ws.currentUser, { preferences: user.preferences });
  console.log(`User ${ws.currentUser} changed ${key} from ${oldColor} to ${value}`);

  // Find all rooms the user is in and force immediate broadcast
  const userRooms = new Set();
  if (userConnections.has(ws.currentUser)) {
    for (const connId of userConnections.get(ws.currentUser)) {
      const room = connectionRooms.get(connId);
      if (room) userRooms.add(room);
    }
  }

  // Force immediate broadcast by resetting the broadcast timers
  for (const room of userRooms) {
    lastRoomBroadcastTime.set(room, 0); // Reset the timer to force broadcast
    console.log(`Forcing color update broadcast for ${ws.currentUser} in room ${room}`);
    broadcastRoomColorData(room);
    
    // Send another update after a delay to ensure clients receive it
    setTimeout(() => broadcastRoomColorData(room), 1000);
  }
}


  function handlePong(ws, data) {
    const { username, room } = data;

    if (!username) return;


    if (username !== ws.currentUser) {
      console.log(`Username changed from ${ws.currentUser} to ${username}`);


      const oldUser = getUser(ws.currentUser);


      if (oldUser) {
        console.log(`Transferring preferences from ${ws.currentUser} to ${username}`);
        updateUser(username, {
          preferences: oldUser.preferences || { color: 'rgb(255, 255, 255)' }
        });
      }


      if (userConnections.has(ws.currentUser)) {

        userConnections.get(ws.currentUser).delete(ws.connectionId);


        if (userConnections.get(ws.currentUser).size === 0) {
          userConnections.delete(ws.currentUser);
        }
      }


      if (!userConnections.has(username)) {
        userConnections.set(username, new Set());
      }
      userConnections.get(username).add(ws.connectionId);


      clients.set(username, ws);


      ws.currentUser = username;
    }


    if (room && room !== connectionRooms.get(ws.connectionId)) {
      handleUpdateRoomStatus(ws, { room });


      setTimeout(() => broadcastRoomColorData(room), 500);
    } else if (room) {

      const now = Date.now();
      const lastBroadcast = lastRoomBroadcastTime.get(room) || 0;
      if (now - lastBroadcast > 10000) {
        broadcastRoomColorData(room);
      }
    }
  }


  function sendError(ws, message) {
    ws.send(JSON.stringify({
      type: 'error',
      message: message
    }));
  }
});


const PING_INTERVAL = 30000;
const heartbeatInterval = setInterval(function ping() {
  wss.clients.forEach(function each(ws) {
    if (ws.isAlive === false) return ws.terminate();

    ws.isAlive = false;
    ws.ping();
  });
}, PING_INTERVAL);


wss.on('close', function close() {
  clearInterval(heartbeatInterval);
});