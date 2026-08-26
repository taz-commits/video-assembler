const express = require('express');
const { randomUUID } = require('crypto');
const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const util = require('util');

const execFileAsyncRaw = util.promisify(execFile);
const execFileAsync = (cmd, args) => execFileAsyncRaw(cmd, args, { maxBuffer: 64 * 1024 * 1024 });

const app = express();
app.use(express.json({ limit: '100mb' }));

const API_KEY = process.env.API_KEY;
const FPS = 30;
const WIDTH = 1080;
const HEIGHT = 1920;

function mimeToExt(mime) {
  if (!mime) return null;
  if (mime.includes('png')) return 'png';
  if (mime.includes('jpeg') || mime.includes('jpg')) return 'jpg';
  if (mime.includes('webp')) return 'webp';
  if (mime.includes('mpeg') || mime.includes('mp3')) return 'mp3';
  if (mime.includes('wav')) return 'wav';
  if (mime.includes('ogg')) return 'ogg';
  return null;
}

app.get('/health', (req, res) => res.json({ ok: true }));

app.post('/assemble', async (req, res) => {
  if (API_KEY) {
    const auth = req.headers.authorization || '';
    if (auth !== `Bearer ${API_KEY}`) {
      return res.status(401).json({ error: 'unauthorized' });
    }
  }

  const parts = req.body && req.body.parts;
  if (!Array.isArray(parts) || parts.length === 0) {
    return res.status(400).json({ error: 'body.parts must be a non-empty array' });
  }

  const workDir = path.join(os.tmpdir(), `assemble-${randomUUID()}`);
  await fs.mkdir(workDir, { recursive: true });

  try {
    const clipPaths = [];

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (!part.image_base64 || !part.audio_base64) {
        throw new Error(`part ${i}: image_base64 and audio_base64 are required`);
      }

      const imageExt = mimeToExt(part.image_mime) || 'png';
      const audioExt = mimeToExt(part.audio_mime) || 'mp3';
      const imagePath = path.join(workDir, `image_${i}.${imageExt}`);
      const audioPath = path.join(workDir, `audio_${i}.${audioExt}`);

      await fs.writeFile(imagePath, Buffer.from(part.image_base64, 'base64'));
      await fs.writeFile(audioPath, Buffer.from(part.audio_base64, 'base64'));

      const { stdout } = await execFileAsync('ffprobe', [
        '-v', 'quiet',
        '-show_entries', 'format=duration',
        '-of', 'csv=p=0',
        audioPath,
      ]);
      const duration = Math.max(parseFloat(stdout.trim()) || 3, 1);
      const totalFrames = Math.max(Math.round(duration * FPS), 1);

      const clipPath = path.join(workDir, `clip_${i}.mp4`);
      const zoompan = `[0:v]scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=increase,crop=${WIDTH}:${HEIGHT},zoompan=z='min(zoom+0.0008,1.3)':d=${totalFrames}:s=${WIDTH}x${HEIGHT}:fps=${FPS}[v]`;

      await execFileAsync('ffmpeg', [
        '-y',
        '-loop', '1', '-i', imagePath,
        '-i', audioPath,
        '-filter_complex', zoompan,
        '-map', '[v]', '-map', '1:a',
        '-t', String(duration),
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '192k',
        clipPath,
      ]);

      clipPaths.push(clipPath);
    }

    const listPath = path.join(workDir, 'list.txt');
    const listContent = clipPaths
      .map((p) => `file '${p.replace(/'/g, "'\\''")}'`)
      .join('\n');
    await fs.writeFile(listPath, listContent);

    const finalPath = path.join(workDir, 'final.mp4');
    await execFileAsync('ffmpeg', [
      '-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', finalPath,
    ]);

    const videoBuffer = await fs.readFile(finalPath);
    res.setHeader('Content-Type', 'video/mp4');
    res.send(videoBuffer);
  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: String((err && err.message) || err),
      code: err && err.code,
      signal: err && err.signal,
      killed: err && err.killed,
      stderrTail: err && err.stderr ? String(err.stderr).slice(-4000) : null,
      stdoutTail: err && err.stdout ? String(err.stdout).slice(-2000) : null,
    });
  } finally {
    fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
});

const port = process.env.PORT || 8080;
app.listen(port, () => {
  console.log(`video-assembler listening on ${port}`);
});
