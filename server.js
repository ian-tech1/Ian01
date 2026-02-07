require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const fs = require('fs');
const qrcode = require('qrcode');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');

// Baileys imports
const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    Browsers,
    delay
} = require('@whiskeysockets/baileys');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

const PORT = process.env.PORT || 3000;

// Configuration
const CONFIG = {
    SESSION_PREFIX: "IAN TECH",
    ADMIN_CONTACT: process.env.ADMIN_CONTACT || "+254723278526",
    PROFILE_PIC_URL: process.env.PROFILE_PIC_URL || "https://files.catbox.moe/fkelmv.jpg",
    AUTH_FOLDER: 'ian_tech_auth',
    SESSION_ID: `IAN TECH-${Date.now()}`
};

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));
app.use('/pairing', express.static('public'));

// Store active sessions
const activeSessions = new Map();
const pairingCodes = new Map(); // Stores pairing codes and their sessions

// Generate 8-digit alphanumeric code
function generatePairingCode() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let code = '';
    for (let i = 0; i < 8; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
}

// Ensure directory exists
function ensureAuthFolder() {
    if (!fs.existsSync(CONFIG.AUTH_FOLDER)) {
        fs.mkdirSync(CONFIG.AUTH_FOLDER, { recursive: true });
    }
}

// Create WhatsApp connection
async function createWhatsAppConnection(sessionId = null) {
    ensureAuthFolder();
    
    const authFolder = sessionId ? `${CONFIG.AUTH_FOLDER}/${sessionId}` : CONFIG.AUTH_FOLDER;
    const { state, saveCreds } = await useMultiFileAuthState(authFolder);
    
    // Generate pairing code for this session
    const pairingCode = generatePairingCode();
    const sessionData = {
        id: sessionId || `IAN-TECH-${Date.now()}`,
        pairingCode: pairingCode,
        qr: null,
        status: 'initializing',
        socket: null,
        authState: { state, saveCreds },
        createdAt: new Date(),
        user: null
    };
    
    activeSessions.set(sessionId || 'default', sessionData);
    pairingCodes.set(pairingCode, sessionData);
    
    console.log(`🆔 Session created: ${sessionData.id}`);
    console.log(`🔢 Pairing Code: ${pairingCode}`);
    
    // Create socket
    const { version } = await fetchLatestBaileysVersion();
    const sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        browser: Browsers.ubuntu('Chrome'),
        logger: require('@whiskeysockets/baileys/lib/utils/logger').default({ level: 'silent' }),
        syncFullHistory: false,
        generateHighQualityLinkPreview: true,
    });
    
    sessionData.socket = sock;
    
    // Handle connection updates
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            console.log(`📱 QR Generated for ${sessionData.id}`);
            sessionData.qr = qr;
            sessionData.status = 'qr_ready';
            
            // Generate QR code image
            try {
                const qrImage = await qrcode.toDataURL(qr);
                sessionData.qrImage = qrImage;
                
                // Emit to all connected clients
                io.emit('qr_update', {
                    sessionId: sessionData.id,
                    qrCode: qrImage,
                    pairingCode: sessionData.pairingCode,
                    status: sessionData.status
                });
            } catch (error) {
                console.error('Error generating QR image:', error);
            }
        }
        
        if (connection === 'open') {
            console.log(`✅ Connected: ${sessionData.id}`);
            sessionData.status = 'connected';
            
            // Get user info
            if (sock.user) {
                sessionData.user = {
                    id: sock.user.id,
                    name: sock.user.name || 'Unknown',
                    phone: sock.user.id.split(':')[0]?.replace(/[^0-9]/g, '')
                };
            }
            
            // Set profile picture
            try {
                if (sock.user && sock.user.id) {
                    await sock.updateProfilePicture(sock.user.id, { 
                        url: CONFIG.PROFILE_PIC_URL 
                    });
                    console.log(`📸 Profile picture set for ${sessionData.id}`);
                }
            } catch (error) {
                console.error('Error setting profile picture:', error);
            }
            
            // Update status
            io.emit('session_update', {
                sessionId: sessionData.id,
                status: sessionData.status,
                user: sessionData.user,
                pairingCode: sessionData.pairingCode
            });
        }
        
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            sessionData.status = 'disconnected';
            
            console.log(`❌ Disconnected: ${sessionData.id}`);
            
            io.emit('session_update', {
                sessionId: sessionData.id,
                status: sessionData.status
            });
            
            if (shouldReconnect) {
                console.log(`🔄 Reconnecting ${sessionData.id}...`);
                setTimeout(() => createWhatsAppConnection(sessionData.id), 5000);
            }
        }
    });
    
    // Save credentials when updated
    sock.ev.on('creds.update', saveCreds);
    
    return sessionData;
}

// API Routes
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/api/sessions', (req, res) => {
    const sessions = Array.from(activeSessions.values()).map(session => ({
        id: session.id,
        pairingCode: session.pairingCode,
        status: session.status,
        user: session.user,
        createdAt: session.createdAt,
        qrAvailable: !!session.qr
    }));
    res.json({ success: true, sessions });
});

app.post('/api/create-session', (req, res) => {
    try {
        const sessionId = req.body.sessionId || `IAN-TECH-${Date.now()}`;
        const sessionData = createWhatsAppConnection(sessionId);
        
        res.json({
            success: true,
            sessionId: sessionData.id,
            pairingCode: sessionData.pairingCode,
            message: 'Session created successfully'
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/pair-with-code', async (req, res) => {
    try {
        const { pairingCode, phoneNumber } = req.body;
        
        if (!pairingCode || !phoneNumber) {
            return res.status(400).json({ 
                success: false, 
                error: 'Pairing code and phone number are required' 
            });
        }
        
        // Validate phone number format
        const cleanedNumber = phoneNumber.replace(/\D/g, '');
        if (!cleanedNumber.startsWith('254') || cleanedNumber.length !== 12) {
            return res.status(400).json({ 
                success: false, 
                error: 'Phone number must be in format: +254723278526' 
            });
        }
        
        const sessionData = pairingCodes.get(pairingCode);
        if (!sessionData) {
            return res.status(404).json({ 
                success: false, 
                error: 'Invalid pairing code' 
            });
        }
        
        if (sessionData.status !== 'connected') {
            return res.status(400).json({ 
                success: false, 
                error: 'Session not connected yet' 
            });
        }
        
        // Send test message to verify pairing
        const jid = `${cleanedNumber}@s.whatsapp.net`;
        await sessionData.socket.sendMessage(jid, {
            text: `✅ You have been paired with IAN TECH WhatsApp Bot!\n\n📞 Admin: ${CONFIG.ADMIN_CONTACT}\n🆔 Session: ${sessionData.id}\n🔢 Code: ${pairingCode}`
        });
        
        res.json({
            success: true,
            message: 'Pairing successful! Check your WhatsApp for confirmation.',
            sessionId: sessionData.id
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/qr/:sessionId', async (req, res) => {
    try {
        const sessionId = req.params.sessionId;
        const sessionData = activeSessions.get(sessionId) || activeSessions.get('default');
        
        if (!sessionData || !sessionData.qr) {
            return res.status(404).json({ 
                success: false, 
                error: 'QR code not available' 
            });
        }
        
        const qrImage = await qrcode.toBuffer(sessionData.qr);
        res.setHeader('Content-Type', 'image/png');
        res.send(qrImage);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/pairing-code/:code', (req, res) => {
    const code = req.params.code;
    const sessionData = pairingCodes.get(code);
    
    if (!sessionData) {
        return res.status(404).json({ 
            success: false, 
            error: 'Invalid pairing code' 
        });
    }
    
    res.json({
        success: true,
        sessionId: sessionData.id,
        status: sessionData.status,
        user: sessionData.user,
        createdAt: sessionData.createdAt
    });
});

// WebSocket connections
io.on('connection', (socket) => {
    console.log(`🔌 Client connected: ${socket.id}`);
    
    // Send current sessions to new client
    const sessions = Array.from(activeSessions.values()).map(session => ({
        id: session.id,
        pairingCode: session.pairingCode,
        status: session.status,
        user: session.user,
        qrAvailable: !!session.qr
    }));
    
    socket.emit('init', { sessions });
    
    socket.on('create_session', (data) => {
        const sessionId = data?.sessionId || `IAN-TECH-${Date.now()}`;
        createWhatsAppConnection(sessionId);
    });
    
    socket.on('get_qr', (data) => {
        const sessionId = data?.sessionId || 'default';
        const sessionData = activeSessions.get(sessionId);
        
        if (sessionData?.qrImage) {
            socket.emit('qr_data', {
                sessionId: sessionData.id,
                qrCode: sessionData.qrImage,
                pairingCode: sessionData.pairingCode
            });
        }
    });
    
    socket.on('disconnect', () => {
        console.log(`🔌 Client disconnected: ${socket.id}`);
    });
});

// Start server
server.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`🌐 Web Interface: http://localhost:${PORT}`);
    console.log(`📱 Pairing Interface: http://localhost:${PORT}/pairing`);
    console.log(`🆔 Session ID starts with: ${CONFIG.SESSION_PREFIX}`);
    console.log(`📸 Profile Picture: ${CONFIG.PROFILE_PIC_URL}`);
    
    // Create default session on startup
    createWhatsAppConnection();
});
