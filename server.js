import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 8080;

// Serve static files from the dist directory
app.use(express.static(join(__dirname, 'dist')));

// Handle requests - try to serve the file, fallback to index.html
app.get('*', (req, res) => {
  const filePath = join(__dirname, 'dist', req.path);

  // If the file exists, it would have been served by express.static
  // Otherwise, serve index.html for SPA-like behavior
  res.sendFile(join(__dirname, 'dist', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
