// api-server.js - FIXED for proper chunk upload handling
const express = require('express');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const morgan = require('morgan');
const multer = require('multer');
const os = require('os');
const { randomUUID } = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// Base storage root outside project folder
const DEFAULT_ROOT = path.join(os.homedir(), 'ShardCloudStorage');
const STORAGE_ROOT = (process.env.STORAGE_ROOT || DEFAULT_ROOT).replace(/[\\/]+$/, '');

// Ensure root exists
fs.mkdirSync(STORAGE_ROOT, { recursive: true });

// CORS
app.use(cors({
  origin: ['http://localhost:5173'],
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  maxAge: 86400
}));
app.use(morgan('tiny'));
app.use(express.json());

// Enhanced in-memory index for chunked files
const index = new Map(); // fileId -> { metadata, chunks: [...] }

// UPDATED: Utility function - removed "files" subfolder
function createUserPath(userEmail, fileId) {
  const sanitizedEmail = sanitizeEmail(userEmail);
  // CHANGED: Direct path without "files" subfolder
  const userDir = path.join(STORAGE_ROOT, 'users', sanitizedEmail, fileId);
  return {
    fileDir: userDir,
    chunksDir: path.join(userDir, 'chunks'),
    metadataFile: path.join(userDir, 'metadata.json')
  };
}


function sanitizeEmail(email) {
  return email.replace(/[^a-zA-Z0-9@._-]/g, '_');
}

// FIXED: Multer configuration - use temporary directory first
const chunkStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    // Use temporary directory since req.body is not available yet
    const tempDir = path.join(STORAGE_ROOT, 'temp');
    fs.mkdirSync(tempDir, { recursive: true });
    cb(null, tempDir);
  },
  filename: (req, file, cb) => {
    // Generate temporary filename
    const tempName = `temp_${Date.now()}_${randomUUID()}`;
    cb(null, tempName);
  }
});

const uploadChunk = multer({
  storage: chunkStorage,
  limits: { fileSize: 1024 * 1024 * 200 } // 200MB per chunk
});

// Legacy upload endpoint (keep for backward compatibility)
const legacyStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dest = path.join(STORAGE_ROOT, 'legacy');
    fs.mkdirSync(dest, { recursive: true });
    cb(null, dest);
  },
  filename: (_req, file, cb) => {
    const id = randomUUID();
    const safe = (file.originalname || 'file').replace(/[^\w.\-]+/g, '_');
    cb(null, `${id}__${safe}`);
  }
});

const upload = multer({
  storage: legacyStorage,
  limits: { fileSize: 1024 * 1024 * 1024 * 5 } // 5 GB
});

// FIXED: Upload chunk endpoint with proper file handling
app.post('/upload-chunk', uploadChunk.single('chunk'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ ok: false, error: 'No chunk file provided' });
    }

    console.log('=== CHUNK UPLOAD REQUEST ===');
    console.log('Body fields:', req.body);
    console.log('File info:', {
      originalname: req.file.originalname,
      filename: req.file.filename,
      path: req.file.path,
      size: req.file.size
    });

    const { 
      fileId, 
      chunkIndex, 
      totalChunks, 
      userEmail, 
      originalFilename 
    } = req.body;

    // Validate required fields
    if (!fileId || chunkIndex === undefined || !totalChunks || !userEmail) {
      // Clean up temp file
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ 
        ok: false, 
        error: 'Missing required fields: fileId, chunkIndex, totalChunks, userEmail',
        received: { fileId, chunkIndex, totalChunks, userEmail }
      });
    }

    const sanitizedEmail = sanitizeEmail(userEmail);
    const chunkIdx = parseInt(chunkIndex);
    const totalChks = parseInt(totalChunks);

    console.log(`Processing chunk ${chunkIdx}/${totalChks - 1} for file ${originalFilename}`);

    // Create proper directory structure
    const paths = createUserPath(sanitizedEmail, fileId);
    fs.mkdirSync(paths.chunksDir, { recursive: true });

    // Move file from temp location to proper chunk location
    const finalChunkPath = path.join(paths.chunksDir, `chunk_${chunkIdx}.bin`);
    fs.renameSync(req.file.path, finalChunkPath);

    console.log(`Chunk moved from ${req.file.path} to ${finalChunkPath}`);

    // Initialize or update file entry in index
    if (!index.has(fileId)) {
      index.set(fileId, {
        fileId,
        originalFilename: originalFilename || 'unknown',
        userEmail: sanitizedEmail,
        totalChunks: totalChks,
        chunksReceived: 0,
        chunks: new Array(totalChks).fill(null),
        createdAt: new Date().toISOString(),
        storageRoot: STORAGE_ROOT
      });
    }

    const fileEntry = index.get(fileId);
    
    // Record this chunk
    fileEntry.chunks[chunkIdx] = {
      index: chunkIdx,
      path: finalChunkPath,
      size: req.file.size,
      uploadedAt: new Date().toISOString()
    };
    
    fileEntry.chunksReceived++;

    // Save metadata to disk
    fs.writeFileSync(paths.metadataFile, JSON.stringify(fileEntry, null, 2));

    console.log(`✅ Chunk ${chunkIdx} stored successfully. Total received: ${fileEntry.chunksReceived}/${totalChks}`);

    res.json({
      ok: true,
      chunkIndex: chunkIdx,
      path: finalChunkPath,
      size: req.file.size,
      totalReceived: fileEntry.chunksReceived,
      totalExpected: totalChks,
      message: `Chunk ${chunkIdx} stored successfully`
    });

  } catch (error) {
    console.error('Chunk upload error:', error);
    
    // Clean up temp file if it exists
    if (req.file && fs.existsSync(req.file.path)) {
      try {
        fs.unlinkSync(req.file.path);
      } catch (cleanupError) {
        console.error('Error cleaning up temp file:', cleanupError);
      }
    }
    
    res.status(500).json({ ok: false, error: error.message });
  }
});

// Modified download endpoint for chunked files
app.get('/files/:id/download', (req, res) => {
  const fileId = req.params.id;
  const { userEmail } = req.query;

  console.log(`=== DOWNLOAD REQUEST ===`);
  console.log(`FileId: ${fileId}`);
  console.log(`UserEmail: ${userEmail}`);

  // Check in-memory index first
  let fileEntry = index.get(fileId);
  
  // If not in memory, try to load from disk
  if (!fileEntry && userEmail) {
    const sanitizedEmail = sanitizeEmail(userEmail);
    const paths = createUserPath(sanitizedEmail, fileId);
    
    if (fs.existsSync(paths.metadataFile)) {
      try {
        const metadata = JSON.parse(fs.readFileSync(paths.metadataFile, 'utf8'));
        index.set(fileId, metadata);
        fileEntry = metadata;
        console.log('Loaded metadata from disk');
      } catch (error) {
        console.error('Error loading metadata:', error);
      }
    }
  }

  if (!fileEntry) {
    console.error('File not found in index or disk');
    return res.status(404).json({ ok: false, error: 'File not found' });
  }

  // Check if all chunks are available
  const missingChunks = [];
  fileEntry.chunks.forEach((chunk, index) => {
    if (!chunk || !fs.existsSync(chunk.path)) {
      missingChunks.push(index);
    }
  });

  if (missingChunks.length > 0) {
    console.error('Missing chunks:', missingChunks);
    return res.status(404).json({ 
      ok: false, 
      error: `Missing chunks: ${missingChunks.join(', ')}` 
    });
  }

  try {
    console.log(`Streaming ${fileEntry.chunks.length} chunks for ${fileEntry.originalFilename}`);
    
    // Set response headers
    res.setHeader('Content-Disposition', `attachment; filename="${fileEntry.originalFilename}"`);
    res.setHeader('Content-Type', 'application/octet-stream');

    // Stream chunks in order
    let currentChunk = 0;

    const streamNextChunk = () => {
      if (currentChunk >= fileEntry.chunks.length) {
        console.log('✅ All chunks streamed successfully');
        res.end();
        return;
      }

      const chunk = fileEntry.chunks[currentChunk];
      console.log(`Streaming chunk ${currentChunk}: ${chunk.path}`);
      const readStream = fs.createReadStream(chunk.path);
      
      readStream.on('error', (error) => {
        console.error(`Error reading chunk ${currentChunk}:`, error);
        if (!res.headersSent) {
          res.status(500).json({ ok: false, error: 'Error reading file chunk' });
        }
      });

      readStream.on('end', () => {
        currentChunk++;
        streamNextChunk();
      });

      readStream.pipe(res, { end: false });
    };

    streamNextChunk();

  } catch (error) {
    console.error('Download error:', error);
    if (!res.headersSent) {
      res.status(500).json({ ok: false, error: 'Failed to download file' });
    }
  }
});

// Updated delete endpoint for chunked files
app.delete('/files/:id', (req, res) => {
  const fileId = req.params.id;
  const { userEmail } = req.query;

  console.log(`=== DELETE REQUEST ===`);
  console.log(`FileId: ${fileId}`);
  console.log(`UserEmail: ${userEmail}`);

  let fileEntry = index.get(fileId);
  
  // Try to load from disk if not in memory
  if (!fileEntry && userEmail) {
    const sanitizedEmail = sanitizeEmail(userEmail);
    const paths = createUserPath(sanitizedEmail, fileId);
    
    if (fs.existsSync(paths.metadataFile)) {
      try {
        const metadata = JSON.parse(fs.readFileSync(paths.metadataFile, 'utf8'));
        fileEntry = metadata;
      } catch (error) {
        console.error('Error loading metadata for deletion:', error);
      }
    }
  }

  if (!fileEntry) {
    return res.status(404).json({ ok: false, error: 'File not found' });
  }

  try {
    const sanitizedEmail = sanitizeEmail(fileEntry.userEmail);
    const paths = createUserPath(sanitizedEmail, fileId);
    
    // Delete all chunk files
    let deletedChunks = 0;
    fileEntry.chunks.forEach((chunk, index) => {
      if (chunk && fs.existsSync(chunk.path)) {
        try {
          fs.unlinkSync(chunk.path);
          deletedChunks++;
          console.log(`Deleted chunk ${index}: ${chunk.path}`);
        } catch (error) {
          console.error(`Error deleting chunk ${index}:`, error);
        }
      }
    });

    // Delete metadata file
    if (fs.existsSync(paths.metadataFile)) {
      fs.unlinkSync(paths.metadataFile);
      console.log('Deleted metadata file');
    }

    // Try to remove empty directories
    try {
      fs.rmdirSync(paths.chunksDir);
      fs.rmdirSync(paths.fileDir);
      console.log('Removed empty directories');
    } catch (error) {
      // Ignore errors - directories might not be empty
    }

    // Remove from index
    index.delete(fileId);

    console.log(`✅ Deleted file ${fileEntry.originalFilename} (${deletedChunks} chunks)`);

    res.json({ 
      ok: true, 
      fileId, 
      filename: fileEntry.originalFilename,
      chunksDeleted: deletedChunks 
    });

  } catch (error) {
    console.error('Delete error:', error);
    res.status(500).json({ ok: false, error: 'Failed to delete file' });
  }
});

// Legacy upload endpoint (keep existing functionality)
app.post('/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, error: 'No file' });
  
  const [id] = req.file.filename.split('__', 1);
  const meta = {
    fileId: id,
    filename: req.file.originalname,
    size: req.file.size,
    path: req.file.path,
    uploadedAt: new Date().toISOString(),
    storageRoot: STORAGE_ROOT,
    type: 'legacy'
  };
  
  index.set(id, meta);
  return res.json({ ok: true, ...meta });
});

// List files endpoint
app.get('/files', (req, res) => {
  const { userEmail } = req.query;
  
  if (userEmail) {
    const userFiles = Array.from(index.values()).filter(file => 
      file.userEmail === sanitizeEmail(userEmail)
    );
    return res.json(userFiles);
  }
  
  res.json(Array.from(index.values()));
});

// Health check
app.get('/health', (_req, res) => {
  res.json({ 
    ok: true, 
    storageRoot: STORAGE_ROOT,
    totalFiles: index.size,
    features: ['chunked-upload', 'user-folders', 'legacy-support']
  });
});

// Debug endpoint
app.get('/debug/files/:id', (req, res) => {
  const fileEntry = index.get(req.params.id);
  if (!fileEntry) {
    return res.status(404).json({ error: 'File not found' });
  }
  
  const paths = createUserPath(fileEntry.userEmail, req.params.id);
  const diskStatus = {
    metadataExists: fs.existsSync(paths.metadataFile),
    chunksDirExists: fs.existsSync(paths.chunksDir),
    chunks: fileEntry.chunks.map((chunk, idx) => ({
      index: idx,
      exists: chunk ? fs.existsSync(chunk.path) : false,
      path: chunk ? chunk.path : null,
      size: chunk ? chunk.size : 0
    }))
  };
  
  res.json({ fileEntry, diskStatus, paths });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 ShardCloud Storage API listening on http://localhost:${PORT}`);
  console.log(`📁 Storage root: ${STORAGE_ROOT}`);
  console.log(`✨ Features: User-specific folders, 5-chunk file splitting, chunk reconstruction`);
});
