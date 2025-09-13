const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const os = require('os');
const app = express();

// Middleware
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static('public'));

// Set EJS as template engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Function to get client IP address
function getClientIP(req) {
    return req.headers['x-forwarded-for'] || 
           req.connection.remoteAddress || 
           req.socket.remoteAddress ||
           (req.connection.socket ? req.connection.socket.remoteAddress : null) ||
           req.ip ||
           'unknown';
}

// Function to create storage path based on user's system
function getStoragePath(clientIP) {
    const homeDir = os.homedir();
    const cleanIP = clientIP.replace(/[^a-zA-Z0-9]/g, '_'); // Clean IP for folder name
    
    // Create storage path in user's Documents folder
    const storagePath = path.join(homeDir, 'Documents', 'CloudStorage', `user_${cleanIP}`);
    
    // Ensure directory exists
    if (!fs.existsSync(storagePath)) {
        fs.mkdirSync(storagePath, { recursive: true });
        console.log(`Created storage directory: ${storagePath}`);
    }
    
    return storagePath;
}

// Enhanced Multer configuration with dynamic storage
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        try {
            const clientIP = getClientIP(req);
            const storagePath = getStoragePath(clientIP);
            
            console.log(`Storing file for IP ${clientIP} at: ${storagePath}`);
            cb(null, storagePath);
        } catch (error) {
            console.error('Error creating storage directory:', error);
            cb(error, null);
        }
    },
    filename: (req, file, cb) => {
        // Create unique filename with timestamp
        const uniqueName = `${Date.now()}-${Math.round(Math.random() * 1E9)}${path.extname(file.originalname)}`;
        cb(null, uniqueName);
    }
});

const upload = multer({ 
    storage: storage,
    limits: {
        fileSize: 100 * 1024 * 1024 // 100MB limit
    },
    fileFilter: (req, file, cb) => {
        // Accept all file types for demo
        cb(null, true);
    }
});

// In-memory storage for demo (use database in production)
let storageProviders = [];
let uploadedFiles = [];

// Routes
app.get('/', (req, res) => {
    res.redirect('/marketplace');
});

// Admin panel
app.get('/admin', (req, res) => {
    res.render('admin', { 
        title: 'Storage Admin Panel',
        providers: storageProviders 
    });
});

// Add new storage provider
app.post('/admin/add-storage', (req, res) => {
    const { providerName, storageSpace, pricePerGB, description } = req.body;
    
    const newProvider = {
        id: Date.now(),
        name: providerName,
        space: parseFloat(storageSpace),
        price: parseFloat(pricePerGB),
        description: description || 'No description provided',
        available: true,
        createdAt: new Date()
    };
    
    storageProviders.push(newProvider);
    console.log('New provider added:', newProvider);
    res.redirect('/admin');
});

// Marketplace page
app.get('/marketplace', (req, res) => {
    res.render('marketplace', { 
        title: 'Storage Marketplace',
        providers: storageProviders 
    });
});

// Payment/Prototype page
app.get('/payment/:id', (req, res) => {
    const providerId = parseInt(req.params.id);
    const provider = storageProviders.find(p => p.id === providerId);
    
    if (!provider) {
        return res.redirect('/marketplace');
    }
    
    res.render('payment', { 
        title: 'Payment - Prototype',
        provider: provider 
    });
});

// Upload page
app.get('/upload/:id', (req, res) => {
    const providerId = parseInt(req.params.id);
    const provider = storageProviders.find(p => p.id === providerId);
    
    if (!provider) {
        return res.redirect('/marketplace');
    }
    
    // Get client IP for filtering files
    const clientIP = getClientIP(req);
    
    // Get files uploaded by this specific client to this provider
    const providerFiles = uploadedFiles.filter(f => 
        f.providerId === providerId && f.clientIP === clientIP
    ) || [];
    
    res.render('upload', { 
        title: 'Upload Files',
        provider: provider,
        uploadedFiles: providerFiles,
        clientIP: clientIP.replace(/[^a-zA-Z0-9]/g, '_')
    });
});

// Handle file upload with IP-based storage
app.post('/upload/:id', upload.single('file'), (req, res) => {
    const providerId = parseInt(req.params.id);
    const provider = storageProviders.find(p => p.id === providerId);
    const clientIP = getClientIP(req);
    
    if (!provider) {
        return res.status(400).json({
            success: false,
            message: 'Provider not found'
        });
    }
    
    if (!req.file) {
        return res.status(400).json({
            success: false,
            message: 'No file uploaded'
        });
    }
    
    // Store file information with client IP
    const fileInfo = {
        id: Date.now(),
        originalName: req.file.originalname,
        filename: req.file.filename,
        path: req.file.path,
        size: req.file.size,
        mimetype: req.file.mimetype,
        providerId: providerId,
        providerName: provider.name,
        clientIP: clientIP,
        storagePath: path.dirname(req.file.path),
        uploadDate: new Date().toLocaleString()
    };
    
    uploadedFiles.push(fileInfo);
    
    console.log(`File uploaded by ${clientIP}:`, fileInfo);
    
    res.json({
        success: true,
        message: `File stored in your local PC at: ${fileInfo.storagePath}`,
        file: fileInfo,
        localPath: fileInfo.path
    });
});

// Get uploaded files for a provider and specific client
app.get('/api/files/:providerId', (req, res) => {
    const providerId = parseInt(req.params.providerId);
    const clientIP = getClientIP(req);
    
    // Only return files uploaded by this specific client
    const providerFiles = uploadedFiles.filter(f => 
        f.providerId === providerId && f.clientIP === clientIP
    );
    
    res.json(providerFiles);
});

// Delete uploaded file (only if uploaded by same client)
app.delete('/api/files/:fileId', (req, res) => {
    const fileId = parseInt(req.params.fileId);
    const clientIP = getClientIP(req);
    
    const fileIndex = uploadedFiles.findIndex(f => 
        f.id === fileId && f.clientIP === clientIP
    );
    
    if (fileIndex === -1) {
        return res.status(404).json({ 
            success: false, 
            message: 'File not found or not authorized to delete' 
        });
    }
    
    const file = uploadedFiles[fileIndex];
    
    // Delete physical file from user's local storage
    fs.unlink(file.path, (err) => {
        if (err) {
            console.error('Error deleting file:', err);
        } else {
            console.log(`File deleted from local storage: ${file.path}`);
        }
    });
    
    // Remove from memory
    uploadedFiles.splice(fileIndex, 1);
    
    res.json({ 
        success: true, 
        message: 'File deleted from your local PC storage' 
    });
});

// Serve uploaded files (only to the client who uploaded them)
app.get('/files/:clientIP/:filename', (req, res) => {
    const requestedClientIP = req.params.clientIP;
    const filename = req.params.filename;
    const actualClientIP = getClientIP(req).replace(/[^a-zA-Z0-9]/g, '_');
    
    // Security check: only serve files to the client who uploaded them
    if (requestedClientIP !== actualClientIP) {
        return res.status(403).json({ 
            error: 'Unauthorized access to file' 
        });
    }
    
    const filePath = getStoragePath(req.params.clientIP.replace(/_/g, '.'));
    const fullPath = path.join(filePath, filename);
    
    // Check if file exists
    if (fs.existsSync(fullPath)) {
        res.sendFile(fullPath);
    } else {
        res.status(404).json({ error: 'File not found' });
    }
});

// Get storage info for current client
app.get('/api/storage-info', (req, res) => {
    const clientIP = getClientIP(req);
    const storagePath = getStoragePath(clientIP);
    
    res.json({
        clientIP: clientIP,
        storagePath: storagePath,
        homeDirectory: os.homedir(),
        platform: os.platform(),
        hostname: os.hostname()
    });
});

// Error handling middleware
app.use((error, req, res, next) => {
    if (error instanceof multer.MulterError) {
        if (error.code === 'LIMIT_FILE_SIZE') {
            return res.status(400).json({
                success: false,
                message: 'File too large. Maximum size is 100MB.'
            });
        }
    }
    
    console.error('Server error:', error);
    res.status(500).json({
        success: false,
        message: 'Internal server error'
    });
});

// 404 handler
app.use((req, res) => {
    res.status(404).send('<h1>Page Not Found</h1><p><a href="/marketplace">Go to Marketplace</a></p>');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`✅ Server running on http://localhost:${PORT}`);
    console.log(`📁 Admin Panel: http://localhost:${PORT}/admin`);
    console.log(`🛒 Marketplace: http://localhost:${PORT}/marketplace`);
    console.log(`💾 Files stored in: ${os.homedir()}/Documents/CloudStorage/`);
});
