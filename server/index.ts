import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

type JobStatus = 'queued' | 'extracting' | 'transcribing' | 'complete' | 'error';

type SubtitleCue = {
  id: string;
  start: string;
  end: string;
  text: string;
};

type Job = {
  id: string;
  status: JobStatus;
  progress: number;
  message: string;
  originalName: string;
  language: string;
  model: string;
  quality: 'fast' | 'balanced' | 'accurate';
  vad: boolean;
  createdAt: string;
  cues?: SubtitleCue[];
  outputs?: { srt: string; vtt: string };
  error?: string;
};

const projectRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const envPath = path.join(projectRoot, '.env');
if (existsSync(envPath)) process.loadEnvFile(envPath);

const runtimeDir = path.join(projectRoot, 'runtime');
const modelDir = path.join(projectRoot, 'models');
const webDistDir = path.join(projectRoot, 'dist');
const port = Number(process.env.PORT || 8787);
const maxUploadBytes = Number(process.env.MAX_UPLOAD_BYTES || 4 * 1024 * 1024 * 1024);

function resolveFromProject(value: string): string {
  return path.isAbsolute(value) ? value : path.join(projectRoot, value);
}

const whisperBinary = resolveFromProject(
  process.env.WHISPER_BIN || 'tools/whisper.cpp/build/bin/whisper-cli',
);
const whisperModel = resolveFromProject(
  process.env.WHISPER_MODEL || 'models/ggml-large-v3-turbo.bin',
);
const whisperVadModel = resolveFromProject(
  process.env.WHISPER_VAD_MODEL || 'models/ggml-silero-v6.2.0.bin',
);
const ffmpegBinary = process.env.FFMPEG_BIN || 'ffmpeg';

const jobs = new Map<string, Job>();
const app = Fastify({ logger: true, bodyLimit: maxUploadBytes });

function serializeJob(job: Job) {
  const { outputs: _outputs, ...publicJob } = job;
  return publicJob;
}

function fieldValue(fields: Record<string, unknown>, name: string): string {
  const rawPart = fields[name];
  const part = Array.isArray(rawPart) ? rawPart[0] : rawPart;
  if (part && typeof part === 'object' && 'value' in part) {
    return String((part as { value: unknown }).value ?? '');
  }
  return '';
}

function modelLabel(fileName: string): string {
  return fileName.replace(/^ggml-/, '').replace(/\.bin$/, '');
}

async function getInstalledModels() {
  const entries = await readdir(modelDir, { withFileTypes: true });
  const models = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && /^ggml-(?!silero-).+\.bin$/.test(entry.name))
      .map(async (entry) => {
        const info = await stat(path.join(modelDir, entry.name));
        return { id: entry.name, label: modelLabel(entry.name), sizeBytes: info.size };
      }),
  );
  const priority = ['large-v3-turbo', 'large-v3', 'medium', 'small', 'base', 'tiny'];
  return models.sort((a, b) => {
    const aRank = priority.indexOf(a.label);
    const bRank = priority.indexOf(b.label);
    return (aRank < 0 ? 999 : aRank) - (bRank < 0 ? 999 : bRank);
  });
}

async function resolveSelectedModel(requested?: string) {
  const installed = await getInstalledModels();
  const configuredId = path.basename(whisperModel);
  const requestedModel = installed.find((model) => model.id === requested);
  return requestedModel || installed.find((model) => model.id === configuredId) || installed[0];
}

function parseSrt(content: string): SubtitleCue[] {
  return content
    .replace(/^\uFEFF/, '')
    .replace(/\r/g, '')
    .trim()
    .split(/\n{2,}/)
    .map((block, index) => {
      const lines = block.split('\n');
      const timingIndex = lines.findIndex((line) => line.includes('-->'));
      if (timingIndex < 0) return null;
      const [start, end] = lines[timingIndex].split('-->').map((value) => value.trim());
      if (!start || !end) return null;
      return {
        id: String(index + 1),
        start,
        end,
        text: lines.slice(timingIndex + 1).join('\n').trim(),
      };
    })
    .filter((cue): cue is SubtitleCue => cue !== null);
}

await mkdir(runtimeDir, { recursive: true });

await app.register(multipart, {
  limits: {
    files: 1,
    fileSize: maxUploadBytes,
  },
});

async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

function executableWorks(command: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: 'ignore' });
    child.once('error', () => resolve(false));
    child.once('close', (code) => resolve(code === 0));
  });
}

function runCommand(
  command: string,
  args: string[],
  onOutput?: (line: string) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: projectRoot });
    let output = '';

    const collect = (chunk: Buffer) => {
      const text = chunk.toString();
      output = (output + text).slice(-20_000);
      text.split(/\r?\n/).forEach((line) => line && onOutput?.(line));
    };

    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.once('error', (error) => reject(error));
    child.once('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${path.basename(command)} 退出，状态码 ${code}\n${output}`));
      }
    });
  });
}

async function processJob(
  job: Job,
  inputPath: string,
  jobDir: string,
  options: { modelPath: string; prompt: string },
) {
  const audioPath = path.join(jobDir, 'audio.wav');
  const outputPrefix = path.join(jobDir, 'subtitles');

  try {
    job.status = 'extracting';
    job.progress = 8;
    job.message = '正在提取音频';

    await runCommand(ffmpegBinary, [
      '-y',
      '-i',
      inputPath,
      '-vn',
      '-ac',
      '1',
      '-ar',
      '16000',
      '-c:a',
      'pcm_s16le',
      audioPath,
    ]);

    job.status = 'transcribing';
    job.progress = 25;
    job.message = '正在识别语音';

    const whisperArgs = [
        '-m',
        options.modelPath,
        '-f',
        audioPath,
        '-l',
        job.language,
        '-osrt',
        '-ovtt',
        '-of',
        outputPrefix,
        '-pp',
      ];

    if (job.quality === 'fast') whisperArgs.push('-bs', '1', '-bo', '1');
    if (job.quality === 'balanced') whisperArgs.push('-bs', '5', '-bo', '5');
    if (job.quality === 'accurate') whisperArgs.push('-bs', '8', '-bo', '8');
    if (options.prompt) whisperArgs.push('--prompt', options.prompt, '--carry-initial-prompt');
    if (job.vad) whisperArgs.push('--vad', '-vm', whisperVadModel, '-vt', '0.35', '-vsd', '300');

    await runCommand(
      whisperBinary,
      whisperArgs,
      (line) => {
        const match = line.match(/progress\s*=\s*(\d+)%/i);
        if (match) {
          job.progress = 25 + Math.round(Number(match[1]) * 0.7);
        }
      },
    );

    const srtPath = `${outputPrefix}.srt`;
    const vttPath = `${outputPrefix}.vtt`;
    await Promise.all([stat(srtPath), stat(vttPath)]);
    job.cues = parseSrt(await readFile(srtPath, 'utf8'));

    job.status = 'complete';
    job.progress = 100;
    job.message = '字幕生成完成';
    job.outputs = { srt: srtPath, vtt: vttPath };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    job.status = 'error';
    job.message = '处理失败';
    job.error = message;
    app.log.error({ err: error, jobId: job.id }, 'Transcription failed');
  } finally {
    await Promise.all([
      rm(inputPath, { force: true }),
      rm(audioPath, { force: true }),
    ]);
  }
}

app.get('/api/health', async () => {
  const [ffmpegReady, whisperReady, installedModels, vadModelReady] = await Promise.all([
    executableWorks(ffmpegBinary, ['-version']),
    executableWorks(whisperBinary, ['--help']),
    getInstalledModels(),
    pathExists(whisperVadModel),
  ]);
  const modelReady = installedModels.length > 0;

  return {
    ready: ffmpegReady && whisperReady && modelReady,
    checks: {
      ffmpeg: ffmpegReady,
      whisper: whisperReady,
      model: modelReady,
      vadModel: vadModelReady,
    },
    paths: {
      whisper: whisperBinary,
      model: whisperModel,
      vadModel: whisperVadModel,
    },
  };
});

app.get('/api/models', async () => {
  const models = await getInstalledModels();
  const selected = await resolveSelectedModel();
  return {
    models,
    selectedId: selected?.id || null,
    recommendedId: 'ggml-large-v3-turbo.bin',
    vadAvailable: await pathExists(whisperVadModel),
  };
});

app.post('/api/transcriptions', async (request, reply) => {
  const upload = await request.file();
  if (!upload) {
    return reply.code(400).send({ error: '请选择一个视频或音频文件。' });
  }

  const fields = upload.fields as unknown as Record<string, unknown>;
  const language = fieldValue(fields, 'language') || 'auto';
  const model = await resolveSelectedModel(fieldValue(fields, 'model'));
  if (!model) {
    await upload.file.resume();
    return reply.code(400).send({ error: '没有找到可用的语音识别模型。' });
  }
  const requestedQuality = fieldValue(fields, 'quality');
  const quality: Job['quality'] = ['fast', 'accurate'].includes(requestedQuality)
    ? requestedQuality as Job['quality']
    : 'balanced';
  const prompt = fieldValue(fields, 'prompt').trim().slice(0, 500);
  const vad = fieldValue(fields, 'vad') === 'true' && await pathExists(whisperVadModel);

  const id = randomUUID();
  const jobDir = path.join(runtimeDir, id);
  await mkdir(jobDir, { recursive: true });
  const inputPath = path.join(jobDir, 'input.media');

  try {
    await pipeline(upload.file, createWriteStream(inputPath));
  } catch (error) {
    await rm(jobDir, { recursive: true, force: true });
    throw error;
  }

  if (upload.file.truncated) {
    await rm(jobDir, { recursive: true, force: true });
    return reply.code(413).send({ error: '文件超过允许的大小。' });
  }

  const job: Job = {
    id,
    status: 'queued',
    progress: 2,
    message: '任务已加入队列',
    originalName: upload.filename,
    language,
    model: model.label,
    quality,
    vad,
    createdAt: new Date().toISOString(),
  };
  jobs.set(id, job);
  void processJob(job, inputPath, jobDir, {
    modelPath: path.join(modelDir, model.id),
    prompt,
  });

  return reply.code(202).send(serializeJob(job));
});

app.get<{ Params: { id: string } }>('/api/jobs/:id', async (request, reply) => {
  const job = jobs.get(request.params.id);
  if (!job) {
    return reply.code(404).send({ error: '找不到这个任务，服务重启后旧任务记录会被清除。' });
  }
  return serializeJob(job);
});

app.get<{ Params: { id: string }; Querystring: { format?: string } }>(
  '/api/jobs/:id/download',
  async (request, reply) => {
    const job = jobs.get(request.params.id);
    const format = request.query.format === 'vtt' ? 'vtt' : 'srt';
    if (!job || job.status !== 'complete' || !job.outputs) {
      return reply.code(404).send({ error: '字幕文件尚未生成。' });
    }

    const outputPath = job.outputs[format];
    const originalBaseName = path.parse(job.originalName).name || 'subtitles';
    const asciiBaseName = originalBaseName.replace(/[^a-zA-Z0-9._-]+/g, '_') || 'subtitles';
    const encodedName = encodeURIComponent(`${originalBaseName}.${format}`);
    reply.header('Content-Type', format === 'vtt' ? 'text/vtt; charset=utf-8' : 'application/x-subrip; charset=utf-8');
    reply.header(
      'Content-Disposition',
      `attachment; filename="${asciiBaseName}.${format}"; filename*=UTF-8''${encodedName}`,
    );
    return reply.send(createReadStream(outputPath));
  },
);

if (await pathExists(webDistDir)) {
  await app.register(fastifyStatic, { root: webDistDir });
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api/')) {
      return reply.code(404).send({ error: '接口不存在。' });
    }
    return reply.sendFile('index.html');
  });
}

await app.listen({ host: '127.0.0.1', port });
app.log.info(`字幕工坊已启动：http://127.0.0.1:${port}`);
