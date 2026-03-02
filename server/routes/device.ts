import express from 'express';
import multer from 'multer';
import * as fs from 'fs';
import * as path from 'path';
import { SSHService } from '../services/sshService.js';

const router = express.Router();
const upload = multer({ dest: 'uploads/' });

// Helper to get SSH service from request body (or session/db in real app)
// For this MVP, we pass credentials in every request or use a temporary store.
// Security Note: Passing private keys in body is risky in production without HTTPS.
const getSSHService = (req: express.Request) => {
  const { host, username, privateKey, passphrase, password } = req.body;
  if (!host || !username || (!privateKey && !password)) {
    throw new Error('Missing SSH credentials (host, username, and either privateKey or password)');
  }
  return new SSHService({ host, username, privateKey, passphrase, password });
};

router.post('/list', async (req, res) => {
  try {
    const ssh = getSSHService(req);
    const docs = await ssh.listDocuments();
    res.json({ documents: docs });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/sync', upload.single('pdf'), async (req, res) => {
  try {
    // Multer puts the file in req.file
    if (!req.file) {
      return res.status(400).json({ error: 'No PDF file uploaded' });
    }

    // Credentials are in req.body (parsed by multer)
    const { host, username, privateKey, passphrase, password, uuid, pageCount } = req.body;
    
    if (!uuid) {
        return res.status(400).json({ error: 'Missing target document UUID' });
    }

    const ssh = new SSHService({ host, username, privateKey, passphrase, password });

    // 1. Validate Page Count
    // We expect the client to send the page count of the generated PDF
    if (pageCount) {
        const isValid = await ssh.validatePageCount(uuid, parseInt(pageCount, 10));
        if (!isValid) {
            // Cleanup upload
            fs.unlinkSync(req.file.path);
            return res.status(409).json({ 
                error: 'Page count mismatch', 
                details: 'The generated PDF has a different page count than the existing document. Overwriting would misalign annotations.' 
            });
        }
    }

    // 2. Backup
    const backupPath = path.join(process.cwd(), 'backups');
    const specificBackupDir = await ssh.backupDocument(uuid, backupPath);

    // 3. Overwrite
    try {
        await ssh.uploadPDF(uuid, req.file.path);
    } catch (uploadError: any) {
        console.error('Upload failed, attempting rollback:', uploadError);
        try {
            await ssh.restoreDocument(uuid, specificBackupDir);
            console.log('Rollback successful');
        } catch (rollbackError: any) {
            console.error('Rollback failed:', rollbackError);
        }
        throw new Error(`Upload failed: ${uploadError.message}`);
    }

    // Cleanup upload
    fs.unlinkSync(req.file.path);

    res.json({ status: 'success', message: 'Document synced successfully' });

  } catch (error: any) {
    // Cleanup upload if it exists
    if (req.file && fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
    }
    console.error('Sync Error:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
