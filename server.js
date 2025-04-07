import http from "http";
import { Server } from "socket.io";
import { PeerServer } from "peer";
import app from "./app.js";
import jwt from "jsonwebtoken";
import User from "./models/User.js";

// Create main HTTP server
const server = http.createServer(app);

// Configure Socket.IO
const io = new Server(server, {
  cors: {
    origin: process.env.CLIENT_URL,
    methods: ["GET", "POST"],
    credentials: true
  }
});

// Configure PeerServer FIRST
const peerServer = PeerServer({
  server: server,
  path: "/peerjs",
  port: 9000,
  proxied: true,
  allow_discovery: true
});
// Authentication middleware
io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) return next(new Error("Authentication error"));
  
  jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
    if (err) return next(new Error("Authentication error"));
    socket.user = decoded;
    next();
  });
});

// Track active rooms: Map<roomId, Map<peerId, userId>>
const activeRooms = new Map();

// Track user-to-peer mappings
const userToPeerMap = new Map();

// Utility functions
const getRoomMembers = (roomId) => {
  return activeRooms.has(roomId) 
    ? Array.from(activeRooms.get(roomId).values())
    : [];
};

const removePeerFromRooms = (peerId) => {
  activeRooms.forEach((peers, roomId) => {
    if (peers.has(peerId)) {
      peers.delete(peerId);
      io.to(roomId).emit("peer-disconnected", { peerId });
      if (peers.size === 0) activeRooms.delete(roomId);
    }
  });
};

// Socket.IO event handlers
io.on("connection", (socket) => {
  console.log(`User ${socket.user.id} connected`);
  let currentPeerId = null;

  // Save the mapping when the user joins a room
  socket.on("register-peer", (peerId) => {
    userToPeerMap.set(socket.user.id, peerId);
    console.log(`Mapped User ID ${socket.user.id} to Peer ID ${peerId}`);
  });

  // Provide the Peer ID for a given user ID
  socket.on("get-peer-id", (userId, callback) => {
    const peerId = userToPeerMap.get(userId);
    if (peerId) {
      callback({ peerId });
    } else {
      callback({ error: "Peer ID not found" });
    }
  });

  // Room management
  socket.on("join-room", async (roomId, peerId) => {
    try {
      // Validate membership
      // const isMember = await MembershipService.verifyMembership(socket.user.id, roomId);
      // if (!isMember) throw new Error("User not authorized for this room");

      // Initialize room structure
      if (!activeRooms.has(roomId)) {
        activeRooms.set(roomId, new Map());
      }

      const room = activeRooms.get(roomId);
      
      // Add peer to room
      room.set(peerId, socket.user.id);
      currentPeerId = peerId;
      socket.join(roomId);

      // Notify existing peers
      const existingPeers = Array.from(room.keys()).filter(id => id !== peerId);
      socket.emit("existing-peers", existingPeers);

      // Notify others about new peer
      socket.to(roomId).emit("peer-connected", { 
        peerId,
        userId: socket.user.id 
      });

      console.log(`User ${socket.user.id} (${peerId}) joined room ${roomId}`);
    } catch (error) {
      socket.emit("room-error", { error: error.message });
    }
  });

  // // Message handling
  // socket.on("client-message-created", async (message, callback) => {
  //   try {
  //     const newMessage = await MessageService.createMessage({
  //       ...message,
  //       sender: socket.user.id
  //     });

  //     io.to(message.room.toString()).emit("server-message-created", newMessage);
  //     callback({ status: "success" });
  //   } catch (error) {
  //     callback({ status: "error", error: error.message });
  //   }
  // });

  // Typing indicators
  const typingTimeouts = new Map();
  socket.on('typing-start', async (roomId) => {
    console.log(`User ${socket.user.id} is typing in room ${roomId}`);
    try {
      const timeoutKey = `${roomId}-${socket.user.id}`;
      const user = await User.findById(socket.user.id);
  
      clearTimeout(typingTimeouts.get(timeoutKey));
  
      // Emit only to others in the room (not to the sender)
      // This didn't work even though the socket.to does not send it to the user who emitted the event 
      socket.to(roomId).emit('user-typing', {
        roomId,
        userId: socket.user.id,
        userName: `${user.firstName} ${user.lastName}`
      });
  
      // Set auto-stop timeout
      typingTimeouts.set(timeoutKey, setTimeout(() => {
        socket.to(roomId).emit('user-stopped-typing', {
          roomId,
          userId: socket.user.id,
        });
        typingTimeouts.delete(timeoutKey);
      }, 3000));
    } catch (error) {
      console.error('Error in typing-start:', error);
    }
  });
  
  socket.on('typing-stop', (roomId) => {
    try {
      const timeoutKey = `${roomId}-${socket.user.id}`;
      clearTimeout(typingTimeouts.get(timeoutKey));
      typingTimeouts.delete(timeoutKey);
      
      // Emit only to others in the room (not to the sender)
      socket.to(roomId).emit('user-stopped-typing', {
        roomId,
        userId: socket.user.id
      });
    } catch (error) {
      console.error('Error in typing-stop:', error);
    }
  });

  // Cleanup on disconnect
  socket.on("disconnect", () => {
    console.log(`User ${socket.user.id} disconnected`);
    
    // Remove from active rooms
    if (currentPeerId) {
      removePeerFromRooms(currentPeerId);
    }

    // Remove the mapping
    userToPeerMap.delete(socket.user.id);
    console.log(`Removed mapping for User ID ${socket.user.id}`);

    // Clear typing indicators
    typingTimeouts.forEach((timeout, key) => {
      if (key.includes(socket.user.id)) {
        clearTimeout(timeout);
        typingTimeouts.delete(key);
      }
    });
  });
});

// Attach io instance to app
app.set("io", io);

// Start server
const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`PeerJS server available at /peerjs`);
});