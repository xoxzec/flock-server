const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const http = require('http');

const port = 3000;
let server;
let wss;

// Rate limiting
const messageCounter = new Map();
const messageCounterStartTime = new Map();
const MAX_MESSAGES_PER_MINUTE = 200;
let activeConnections = 0;
const MAX_CONNECTIONS = 200;

// Core data structures
const sessions = new Map();           // Maps connectionId -> {username, flockmodUsername, room}
const userColors = new Map();         // Maps username -> color preference (rename from profileColors)
const roomUsers = new Map();          // Maps roomName -> Set of flockmod usernames
const usernameToProfile = new Map();  // Maps roomName+flockmodUsername -> socketMod username
const connectionIds = new Map();      // Maps username -> Set of connectionIds
const pendingBroadcasts = new Map();  // For batching room updates

// Database setup
const DB_DIR = path.join(__dirname, 'db');
const PROFILES_FILE = path.join(DB_DIR, 'profile_preferences.json');

// Ensure database directory exists
if (!fs.existsSync(DB_DIR)) {
  fs.mkdirSync(DB_DIR);
}

// Ensure profiles file exists
if (!fs.existsSync(PROFILES_FILE)) {
  fs.writeFileSync(PROFILES_FILE, JSON.stringify({}));
}

// Database functions
function loadProfilePreferences() {
  try {
    const data = fs.readFileSync(PROFILES_FILE, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    console.error('Error loading profile preferences:', error);
    return {};
  }
}

function saveProfilePreferences(preferences) {
  try {
    fs.writeFileSync(PROFILES_FILE, JSON.stringify(preferences, null, 2));
  } catch (error) {
    console.error('Error saving profile preferences:', error);
  }
}

function getProfilePreference(username) {
  const preferences = loadProfilePreferences();
  return preferences[username] || { color: 'rgb(255, 255, 255)' };
}

function saveProfilePreference(username, key, value) {
  const preferences = loadProfilePreferences();

  if (!preferences[username]) {
    preferences[username] = {};
  }

  preferences[username][key] = value;
  preferences[username].lastUpdated = new Date().toISOString();

  saveProfilePreferences(preferences);

  // Also update in-memory cache
  if (key === 'color') {
    userColors.set(username, value); // Changed from profileColors
  }

  return preferences[username];
}

// Initialize profile colors from database
function initProfileColors() {
  const preferences = loadProfilePreferences();
  for (const [username, prefs] of Object.entries(preferences)) {
    if (prefs.color) {
      userColors.set(username, prefs.color); // Changed from profileColors
    }
  }
}

// Create HTTP server
server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('FlockMod WebSocket server running');
});

// Create WebSocket server
wss = new WebSocket.Server({ server });

server.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
  console.log(`WebSocket endpoint: ws://localhost:${port}`);

  // Load profile colors from database
  initProfileColors();
});

// Helper functions
function ensureRoomExists(roomName) {
  if (!roomUsers.has(roomName)) {
    roomUsers.set(roomName, new Set());
  }
}

function getRoomUserKey(roomName, username) {
  return `${roomName}:${username}`;
}

function addUserToRoom(roomName, flockmodUsername, socketModUsername) {
  if (!roomName || roomName === 'NaN' || !flockmodUsername) return;

  ensureRoomExists(roomName);
  roomUsers.get(roomName).add(flockmodUsername);

  // Map this flockmod username to this socketmod username in this room
  const userKey = getRoomUserKey(roomName, flockmodUsername);
  usernameToProfile.set(userKey, socketModUsername);

  // Schedule a room broadcast
  scheduleRoomBroadcast(roomName);
}

function removeUserFromRoom(roomName, flockmodUsername) {
  if (!roomName || roomName === 'NaN' || !flockmodUsername) return;

  if (roomUsers.has(roomName)) {
    roomUsers.get(roomName).delete(flockmodUsername);

    // Remove username to profile mapping
    const userKey = getRoomUserKey(roomName, flockmodUsername);
    usernameToProfile.delete(userKey);

    // If room is empty, clean up
    if (roomUsers.get(roomName).size === 0) {
      roomUsers.delete(roomName);
    }
  }
}

function getUserColor(username) {
  // First check in-memory cache
  if (userColors.has(username)) {
    return userColors.get(username);
  }

  // If not in cache, load from database
  const prefs = getProfilePreference(username);
  const color = prefs.color || 'rgb(255, 255, 255)';

  // Update cache
  userColors.set(username, color);

  return color;
}

function scheduleRoomBroadcast(roomName) {
  if (!roomName || roomName === 'NaN') return;

  // If a broadcast is already scheduled, don't schedule another one
  if (pendingBroadcasts.has(roomName)) return;

  // Schedule a broadcast for this room
  pendingBroadcasts.set(roomName, setTimeout(() => {
    pendingBroadcasts.delete(roomName);
    broadcastRoomColorData(roomName);
  }, 100)); // Short delay to batch updates
}

function getUsersInRoom(roomName) {
  return roomUsers.has(roomName) ? Array.from(roomUsers.get(roomName)) : [];
}

function buildRoomColorData(roomName) {
  const colorData = {};
  const profileMap = {};

  if (roomUsers.has(roomName)) {
    for (const flockmodUsername of roomUsers.get(roomName)) {
      const userKey = getRoomUserKey(roomName, flockmodUsername);
      const socketModUsername = usernameToProfile.get(userKey);

      if (socketModUsername) {
        const color = getUserColor(socketModUsername);
        colorData[flockmodUsername] = color;
        profileMap[flockmodUsername] = socketModUsername;
      }
    }
  }

  return { colorData, profileMap };
}

function broadcastToRoom(roomName, message) {
  if (!roomName || roomName === 'NaN') return;

  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      const session = sessions.get(client.connectionId);
      if (session && session.room === roomName) {
        client.send(JSON.stringify(message));
      }
    }
  });
}

function sendRoomColorData(ws, roomName) {
  if (!roomName || roomName === 'NaN') return;

  const session = sessions.get(ws.connectionId);
  if (!session) return;

  const { colorData, profileMap } = buildRoomColorData(roomName);

  if (ws.readyState === WebSocket.OPEN) {
    console.log(`Sending color data to client (conn: ${ws.connectionId.substr(0, 6)}) for room ${roomName}: ${Object.keys(colorData).length} users`);
    ws.send(JSON.stringify({
      type: 'roomColorSync',
      room: roomName,
      colorData: colorData,
      profileMap: profileMap
    }));
  }
}

function broadcastRoomColorData(roomName) {
  if (!roomName || roomName === 'NaN') return;

  const { colorData, profileMap } = buildRoomColorData(roomName);
  console.log(`Broadcasting colors to room ${roomName} with users: ${getUsersInRoom(roomName).join(', ')}`);

  broadcastToRoom(roomName, {
    type: 'roomColorSync',
    room: roomName,
    colorData: colorData,
    profileMap: profileMap
  });
}

function broadcastUserLeftRoom(flockmodUsername, roomName) {
  if (!roomName || roomName === 'NaN' || !flockmodUsername) return;

  broadcastToRoom(roomName, {
    type: 'userLeftRoom',
    username: flockmodUsername
  });
}

// WebSocket connection handler
wss.on('connection', function connection(ws) {
  // Check connection limit
  if (activeConnections >= MAX_CONNECTIONS) {
    console.log(`Connection limit reached (${MAX_CONNECTIONS}). Rejecting new connection.`);
    ws.close(1013, "Maximum number of connections reached");
    return;
  }

  activeConnections++;

  // Initialize connection
  ws.connectionId = Date.now() + Math.random().toString(36).substr(2, 9);
  console.log(`Client connected with connection ID: ${ws.connectionId.substr(0, 6)}`);
  ws.isAlive = true;

  ws.on('pong', function () {
    this.isAlive = true;
  });

  ws.on('message', function incoming(message) {
    try {
      // Rate limiting
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

      // Message size limit
      if (message.toString().length > 1000) {
        console.log(`Message too long from ${ws.connectionId.substr(0, 6)}. Ignoring.`);
        return;
      }

      const data = JSON.parse(message.toString());
      console.log(`Received from ${ws.connectionId.substr(0, 6)}: ${JSON.stringify(data)}`);

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

    const session = sessions.get(ws.connectionId);
    if (session) {
      const { username, flockmodUsername, room } = session;

      // Clean up connection tracking
      if (connectionIds.has(username)) {
        connectionIds.get(username).delete(ws.connectionId);
        if (connectionIds.get(username).size === 0) {
          connectionIds.delete(username);
        }
      }

      // Check if this user has any other connections in this room
      const userStillInRoom = Array.from(connectionIds.get(username) || [])
        .some(connId => {
          const otherSession = sessions.get(connId);
          return otherSession && otherSession.room === room;
        });

      // If user no longer in room, remove flockmod username from room
      if (!userStillInRoom && room && flockmodUsername) {
        removeUserFromRoom(room, flockmodUsername);
        broadcastUserLeftRoom(flockmodUsername, room);
        console.log(`FlockMod username ${flockmodUsername} has left room ${room} (user disconnected)`);

        // Broadcast updated color data
        broadcastRoomColorData(room);
      }

      sessions.delete(ws.connectionId);
    }

    // Clean up rate limiting data
    messageCounter.delete(ws.connectionId);
    messageCounterStartTime.delete(ws.connectionId);
  });

  function handleLogin(ws, data) {
    const { username } = data;

    if (!username || typeof username !== 'string') {
      return sendError(ws, 'Username is required');
    }

    // Load profile preferences
    const userPrefs = getProfilePreference(username);
    const color = userPrefs.color || 'rgb(255, 255, 255)';

    // Store color in memory cache
    userColors.set(username, color);

    // Create session (note: no flockmod username yet)
    const session = {
      username: username,
      flockmodUsername: null,
      room: null
    };

    sessions.set(ws.connectionId, session);

    // Track connection for this username
    if (!connectionIds.has(username)) {
      connectionIds.set(username, new Set());
    }
    connectionIds.get(username).add(ws.connectionId);

    console.log(`User ${username} logged in with connection ${ws.connectionId.substr(0, 6)}, color: ${color}`);

    ws.send(JSON.stringify({
      type: 'loginSuccess',
      username: username,
      preferences: { color: color }
    }));
  }

  function handlePong(ws, data) {
    const { username, flockmodUsername, room } = data;

    if (!username) return;

    const session = sessions.get(ws.connectionId);
    if (!session) {
      // No session found, create one
      return handleLogin(ws, { username });
    }

    // Always ensure the user color is in memory
    if (!userColors.has(username)) {
      const userPrefs = getProfilePreference(username);
      userColors.set(username, userPrefs.color || 'rgb(255, 255, 255)');
    }

    // Handle flockmod username changes
    if (flockmodUsername && flockmodUsername !== session.flockmodUsername) {
      handleFlockmodUsernameChange(ws, session, flockmodUsername);
    }

    // Handle room changes
    if (room && room !== session.room) {
      handleRoomChange(ws, session, room);
    }
    else if (room && session.room && flockmodUsername && session.flockmodUsername) {
      // Make sure flockmod username is still in room with correct profile mapping
      addUserToRoom(session.room, session.flockmodUsername, session.username);

      // Send room data periodically
      sendRoomColorData(ws, session.room);
    }
  }

  function handleFlockmodUsernameChange(ws, session, newFlockmodUsername) {
    const oldFlockmodUsername = session.flockmodUsername;
    const currentRoom = session.room;

    console.log(`FlockMod username changed from ${oldFlockmodUsername || 'none'} to ${newFlockmodUsername} for user ${session.username}`);

    // If in a room, remove old username from room
    if (currentRoom && oldFlockmodUsername) {
      removeUserFromRoom(currentRoom, oldFlockmodUsername);
      broadcastUserLeftRoom(oldFlockmodUsername, currentRoom);
      console.log(`FlockMod username ${oldFlockmodUsername} has left room ${currentRoom} (username changed)`);
    }

    // Update session with new flockmod username
    session.flockmodUsername = newFlockmodUsername;

    // If in a room, add new username to room
    if (currentRoom && newFlockmodUsername) {
      addUserToRoom(currentRoom, newFlockmodUsername, session.username);
      console.log(`FlockMod username ${newFlockmodUsername} joined room ${currentRoom}`);

      // Broadcast updated color data
      broadcastRoomColorData(currentRoom);
    }
  }

  function handleRoomChange(ws, session, newRoom) {
    const oldRoom = session.room;
    const flockmodUsername = session.flockmodUsername;

    console.log(`Room changed from ${oldRoom || 'none'} to ${newRoom} for user ${session.username}`);

    // Remove from old room if exists
    if (oldRoom && flockmodUsername) {
      removeUserFromRoom(oldRoom, flockmodUsername);
      broadcastUserLeftRoom(flockmodUsername, oldRoom);
      console.log(`FlockMod username ${flockmodUsername} has left room ${oldRoom}`);

      // Broadcast updated color data to old room
      broadcastRoomColorData(oldRoom);
    }

    // Update session with new room
    session.room = newRoom;

    // Add to new room if have a flockmod username
    if (newRoom && flockmodUsername) {
      addUserToRoom(newRoom, flockmodUsername, session.username);
      console.log(`FlockMod username ${flockmodUsername} joined room ${newRoom}`);

      // Send room color data to the user
      sendRoomColorData(ws, newRoom);

      // Broadcast updated color data to new room
      broadcastRoomColorData(newRoom);
    }
  }

  function handleUpdateRoomStatus(ws, data) {
    const { room, flockmodUsername } = data;

    if (!room || typeof room !== 'string') {
      return sendError(ws, 'Invalid room name');
    }

    const session = sessions.get(ws.connectionId);
    if (!session) {
      return sendError(ws, 'Not logged in');
    }

    // Update flockmod username if provided
    if (flockmodUsername && flockmodUsername !== session.flockmodUsername) {
      handleFlockmodUsernameChange(ws, session, flockmodUsername);
    }

    // Update room if changed
    if (room !== session.room) {
      handleRoomChange(ws, session, room);
    } else {
      // Same room, just send the current data
      sendRoomColorData(ws, room);
    }
  }

  function handleSetPreference(ws, data) {
    const { key, value } = data;

    if (key !== 'color') {
      return sendError(ws, 'Only color preference is supported');
    }

    const session = sessions.get(ws.connectionId);
    if (!session) {
      return sendError(ws, 'Not logged in');
    }

    const username = session.username;
    if (!username) {
      return sendError(ws, 'No username associated with this session');
    }

    const oldColor = userColors.get(username) || 'rgb(255, 255, 255)';

    // Save preference to database for the profile
    saveProfilePreference(username, key, value);

    console.log(`User ${username} changed color from ${oldColor} to ${value}`);

    // Update all sessions for this username
    updateUserSessions(username, value);

    // Also send directly to the user to ensure they have the latest data
    if (session.room) {
      sendRoomColorData(ws, session.room);
    }
  }

  function updateUserSessions(username, color) {
    const rooms = new Set();

    // Update all sessions for this username
    wss.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        const clientSession = sessions.get(client.connectionId);
        if (clientSession && clientSession.username === username) {
          if (clientSession.room && clientSession.flockmodUsername) {
            // Add room to list of rooms to update
            rooms.add(clientSession.room);
          }
        }
      }
    });

    // Update color data in all affected rooms
    for (const room of rooms) {
      broadcastRoomColorData(room);
    }
  }

  function sendError(ws, message) {
    ws.send(JSON.stringify({
      type: 'error',
      message: message
    }));
  }
});

// Heartbeat to keep connections alive and detect disconnects
const PING_INTERVAL = 30000;
const heartbeatInterval = setInterval(function ping() {
  wss.clients.forEach(function each(ws) {
    if (ws.isAlive === false) return ws.terminate();

    ws.isAlive = false;
    ws.ping();
  });
}, PING_INTERVAL);

// Periodic check to ensure room color data is up to date
const UPDATE_INTERVAL = 30000;
const updateInterval = setInterval(function updateColors() {
  roomUsers.forEach((users, roomName) => {
    if (users.size > 0) {
      broadcastRoomColorData(roomName);
    }
  });
}, UPDATE_INTERVAL);

wss.on('close', function close() {
  clearInterval(heartbeatInterval);
  clearInterval(updateInterval);
});