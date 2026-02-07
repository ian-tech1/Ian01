const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const fs = require('fs-extra');
const path = require('path');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const chalk = require('chalk');

// Import Baileys
const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    getAggregateVotesInPollMessage,
    makeCacheableSignalKeyStore,
    proto,
    delay
} = require('@whiskeysockets/baileys');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

const PORT = process.env.PORT || 3000;

// Serve static files
app.use(express.static('public'));
app.use(express.json());

// Store bot instance and connection status
let sock = null;
let qr = '';
let status = 'disconnected';
let isConnecting = false;

// Ensure directories exist
const ensureDirectories = () => {
    const dirs = ['auth_info_baileys', 'public'];
    dirs.forEach(dir => {
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
    });
};

// Initialize WhatsApp connection
async function connectToWhatsApp() {
    ensureDirectories();
    
    if (isConnecting) {
        console.log(chalk.yellow('⚠️  Connection already in progress...'));
        return;
    }
    
    isConnecting = true;
    status = 'connecting';
    io.emit('status', status);
    
    try {
        const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
        
        // Fetch latest version
        const { version, isLatest } = await fetchLatestBaileysVersion();
        console.log(chalk.blue(`✓ Using WA v${version.join('.')}, isLatest: ${isLatest}`));
        
        sock = makeWASocket({
            version,
            logger: pino({ level: 'silent' }),
            printQRInTerminal: false,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'fatal' })),
            },
            generateHighQualityLinkPreview: true,
            shouldIgnoreJid: jid => jid?.endsWith('@broadcast'),
            getMessage: async key => {
                return {
                    conversation: 'Hello, I am a bot!'
                };
            },
        });
        
        // Save credentials on update
        sock.ev.on('creds.update', saveCreds);
        
        // Handle connection updates
        sock.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect, qr: qrCode } = update;
            
            if (qrCode) {
                qr = qrCode;
                qrcode.generate(qr, { small: true });
                console.log(chalk.cyan('📱 Scan the QR code above with WhatsApp'));
                io.emit('qr', qrCode);
                status = 'qr_ready';
                io.emit('status', status);
            }
            
            if (connection === 'open') {
                status = 'connected';
                isConnecting = false;
                console.log(chalk.green('✓ WhatsApp connected successfully!'));
                io.emit('status', status);
                io.emit('connected', {
                    user: sock.user,
                    phone: sock.user?.id.split(':')[0]
                });
            }
            
            if (connection === 'close') {
                status = 'disconnected';
                isConnecting = false;
                const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
                
                console.log(chalk.red('⚠️  Connection closed.'));
                console.log('Reconnecting:', shouldReconnect);
                io.emit('status', status);
                
                if (shouldReconnect) {
                    console.log(chalk.yellow('🔄 Reconnecting in 5 seconds...'));
                    setTimeout(connectToWhatsApp, 5000);
                } else {
                    console.log(chalk.red('❌ Logged out. Delete auth_info_baileys folder to re-login.'));
                    io.emit('logout', true);
                }
            }
        });
        
        // Handle incoming messages
        sock.ev.on('messages.upsert', async ({ messages, type }) => {
            if (type !== 'notify') return;
            
            for (const msg of messages) {
                if (msg.key.fromMe) continue;
                
                const jid = msg.key.remoteJid;
                const text = msg.message?.conversation || 
                           msg.message?.extendedTextMessage?.text || 
                           msg.message?.imageMessage?.caption ||
                           '';
                
                console.log(chalk.gray(`📩 Message from ${jid}: ${text}`));
                
                // Broadcast to web interface
                io.emit('message', {
                    from: jid,
                    text: text,
                    timestamp: new Date().toISOString(),
                    type: 'received'
                });
                
                // Auto-reply
                if (text.toLowerCase().includes('hello') || text.toLowerCase().includes('hi')) {
                    await sock.sendMessage(jid, { text: 'Hello! I am IAN TECH Bot. How can I help you?' });
                    
                    io.emit('message', {
                        from: 'Bot',
                        text: 'Hello! I am IAN TECH Bot. How can I help you?',
                        timestamp: new Date().toISOString(),
                        type: 'sent'
                    });
                }
            }
        });
        
        // Handle message status updates
        sock.ev.on('messages.update', (updates) => {
            for (const update of updates) {
                if (update.update) {
                    io.emit('message_status', {
                        id: update.key.id,
                        status: update.update.status
                    });
                }
            }
        });
        
    } catch (error) {
        console.error(chalk.red('❌ Connection error:'), error);
        status = 'error';
        isConnecting = false;
        io.emit('status', status);
        io.emit('error', error.message);
        
        // Try to reconnect
        setTimeout(connectToWhatsApp, 10000);
    }
}

// API Routes
app.get('/api/status', (req, res) => {
    res.json({
        status,
        qr: qr ? 'available' : 'none',
        connected: status === 'connected',
        user: sock?.user || null
    });
});

app.post('/api/send', async (req, res) => {
    const { number, message } = req.body;
    
    if (!number || !message) {
        return res.status(400).json({ error: 'Number and message are required' });
    }
    
    if (status !== 'connected') {
        return res.status(400).json({ error: 'Bot is not connected' });
    }
    
    try {
        const jid = number.includes('@') ? number : `${number}@s.whatsapp.net`;
        await sock.sendMessage(jid, { text: message });
        
        io.emit('message', {
            from: 'Bot',
            text: message,
            timestamp: new Date().toISOString(),
            type: 'sent',
            to: number
        });
        
        res.json({ success: true, message: 'Message sent' });
    } catch (error) {
        console.error('Send error:', error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/restart', (req, res) => {
    if (sock) {
        sock.end();
        sock = null;
    }
    
    // Clear auth data
    fs.removeSync('auth_info_baileys');
    
    setTimeout(() => {
        connectToWhatsApp();
        res.json({ success: true, message: 'Restarting...' });
    }, 2000);
});

// Socket.IO connection
io.on('connection', (socket) => {
    console.log(chalk.gray('🌐 New client connected'));
    
    // Send current status
    socket.emit('status', status);
    if (qr) {
        socket.emit('qr', qr);
    }
    if (status === 'connected' && sock?.user) {
        socket.emit('connected', {
            user: sock.user,
            phone: sock.user?.id.split(':')[0]
        });
    }
    
    socket.on('disconnect', () => {
        console.log(chalk.gray('🌐 Client disconnected'));
    });
});

// Start server
server.listen(PORT, () => {
    console.log(chalk.green(`🚀 Server running on port ${PORT}`));
    console.log(chalk.blue(`🌐 Web interface: http://localhost:${PORT}`));
    
    // Start WhatsApp connection
    connectToWhatsApp();
});
