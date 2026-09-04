import { Fragment, useCallback, useEffect, useRef, useState } from 'react';

type Health = {
  ready: boolean;
  checks: { ffmpeg: boolean; whisper: boolean; model: boolean; vadModel: boolean };
};

type ModelInfo = { id: string; label: string; sizeBytes: number };
type ModelsResponse = {
  models: ModelInfo[];
  selectedId: string | null;
  recommendedId: string;
  vadAvailable: boolean;
};

type SubtitleCue = {
  id: string;
  start: string;
  end: string;
  text: string;
};

type Job = {
  id: string;
  status: 'queued' | 'extracting' | 'transcribing' | 'complete' | 'error';
  progress: number;
  message: string;
  originalName: string;
  language: string;
  model: string;
  quality: 'fast' | 'balanced' | 'accurate';
  vad: boolean;
  cues?: SubtitleCue[];
  error?: string;
};

const languages = [
  ['auto', '自动检测'], ['zh', '中文'], ['en', '英语'], ['ja', '日语'],
  ['ko', '韩语'], ['es', '西班牙语'], ['fr', '法语'], ['de', '德语'],
];

function formatBytes(bytes: number) {
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

function timeToMs(value: string) {
  const match = value.match(/^(\d{2}):(\d{2}):(\d{2})[,.](\d{3})$/);
  if (!match) return Number.NaN;
  return ((Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])) * 1000) + Number(match[4]);
}

function msToTime(ms: number) {
  const safe = Math.max(0, ms);
  const hours = Math.floor(safe / 3_600_000);
  const minutes = Math.floor((safe % 3_600_000) / 60_000);
  const seconds = Math.floor((safe % 60_000) / 1000);
  const milliseconds = safe % 1000;
  return [hours, minutes, seconds].map((part) => String(part).padStart(2, '0')).join(':') + `,${String(milliseconds).padStart(3, '0')}`;
}

function cueIsValid(cue: SubtitleCue) {
  const start = timeToMs(cue.start);
  const end = timeToMs(cue.end);
  return Number.isFinite(start) && Number.isFinite(end) && end >= start;
}

function isEditingTarget(target: EventTarget | null) {
  return target instanceof HTMLElement && (
    target.isContentEditable
    || target.tagName === 'INPUT'
    || target.tagName === 'TEXTAREA'
    || target.tagName === 'SELECT'
  );
}

function normalizeFrameRate(value: number) {
  const commonRates = [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60, 100, 119.88, 120];
  const nearest = commonRates.reduce((best, rate) => Math.abs(rate - value) < Math.abs(best - value) ? rate : best);
  return Math.abs(nearest - value) / nearest < 0.02 ? nearest : Math.round(value * 100) / 100;
}

function UploadIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 16V4m0 0L7 9m5-5 5 5M5 14v5h14v-5" /></svg>;
}

export default function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [mediaUrl, setMediaUrl] = useState('');
  const [language, setLanguage] = useState('auto');
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [selectedModel, setSelectedModel] = useState('');
  const [quality, setQuality] = useState<'fast' | 'balanced' | 'accurate'>('balanced');
  const [useVad, setUseVad] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [job, setJob] = useState<Job | null>(null);
  const [cues, setCues] = useState<SubtitleCue[]>([]);
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [message, setMessage] = useState('');
  const [playbackTime, setPlaybackTime] = useState(0);
  const [mediaDuration, setMediaDuration] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [seekStepInput, setSeekStepInput] = useState('500');
  const [seekMode, setSeekMode] = useState<'milliseconds' | 'frames'>('milliseconds');
  const [frameStepInput, setFrameStepInput] = useState('1');
  const [fpsInput, setFpsInput] = useState('30');
  const [detectedFps, setDetectedFps] = useState<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const mediaRef = useRef<HTMLMediaElement | null>(null);
  const cueRefs = useRef(new Map<string, HTMLElement>());
  const videoFrameRequestRef = useRef<number | null>(null);
  const lastVideoFrameTimeRef = useRef<number | null>(null);
  const frameDurationSamplesRef = useRef<number[]>([]);
  const detectedFpsRef = useRef<number | null>(null);
  const fpsManuallyEditedRef = useRef(false);

  const loadHealth = useCallback(async () => {
    try {
      const [healthResponse, modelsResponse] = await Promise.all([
        fetch('/api/health'),
        fetch('/api/models'),
      ]);
      if (!healthResponse.ok || !modelsResponse.ok) throw new Error();
      const nextHealth: Health = await healthResponse.json();
      const modelData: ModelsResponse = await modelsResponse.json();
      setHealth(nextHealth);
      setModels(modelData.models);
      setSelectedModel((current) => modelData.models.some((model) => model.id === current)
        ? current
        : modelData.selectedId || '');
    } catch {
      setHealth(null);
    }
  }, []);

  const seekBy = useCallback((deltaMs: number) => {
    const media = mediaRef.current;
    if (!media) return;
    const duration = Number.isFinite(media.duration) ? media.duration : Number.POSITIVE_INFINITY;
    const nextTime = Math.max(0, Math.min(media.currentTime + deltaMs / 1000, duration));
    media.currentTime = nextTime;
    setPlaybackTime(nextTime);
  }, []);

  useEffect(() => { void loadHealth(); }, [loadHealth]);

  useEffect(() => {
    if (!file) { setMediaUrl(''); return; }
    const url = URL.createObjectURL(file);
    setMediaUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  useEffect(() => {
    if (!job || job.status === 'complete' || job.status === 'error') return;
    const timer = window.setInterval(async () => {
      try {
        const response = await fetch(`/api/jobs/${job.id}`);
        if (!response.ok) return;
        const nextJob: Job = await response.json();
        setJob(nextJob);
        if (nextJob.status === 'complete') setCues(nextJob.cues || []);
      } catch {
        setMessage('暂时无法连接本地服务，正在继续等待。');
      }
    }, 1000);
    return () => window.clearInterval(timer);
  }, [job]);

  const seekStepMs = Math.min(60_000, Math.max(1, Number.parseInt(seekStepInput, 10) || 500));
  const frameStep = Math.min(100, Math.max(1, Number.parseInt(frameStepInput, 10) || 1));
  const framesPerSecond = Math.min(240, Math.max(1, Number.parseFloat(fpsInput) || 30));
  const seekAmountMs = seekMode === 'frames' ? frameStep * 1000 / framesPerSecond : seekStepMs;
  const seekAmountLabel = seekMode === 'frames' ? `${frameStep} 帧` : `${seekStepMs} ms`;

  useEffect(() => {
    if (!file) return;
    function handleKeyboardSeek(event: KeyboardEvent) {
      if (isEditingTarget(event.target) || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return;
      event.preventDefault();
      seekBy(event.key === 'ArrowLeft' ? -seekAmountMs : seekAmountMs);
    }
    window.addEventListener('keydown', handleKeyboardSeek);
    return () => window.removeEventListener('keydown', handleKeyboardSeek);
  }, [file, seekAmountMs, seekBy]);

  function chooseFile(nextFile?: File) {
    if (!nextFile) return;
    if (mediaRef.current instanceof HTMLVideoElement && videoFrameRequestRef.current !== null) {
      mediaRef.current.cancelVideoFrameCallback(videoFrameRequestRef.current);
    }
    mediaRef.current?.pause();
    videoFrameRequestRef.current = null;
    lastVideoFrameTimeRef.current = null;
    frameDurationSamplesRef.current = [];
    detectedFpsRef.current = null;
    fpsManuallyEditedRef.current = false;
    setFile(nextFile);
    setJob(null);
    setCues([]);
    setMessage('');
    setPlaybackTime(0);
    setMediaDuration(0);
    setIsPlaying(false);
    setDetectedFps(null);
    setFpsInput('30');
  }

  async function startTranscription() {
    if (!file || !health?.ready) return;
    setUploading(true);
    setJob(null);
    setCues([]);
    setMessage('正在将文件交给本地处理服务…');
    const body = new FormData();
    body.append('language', language);
    body.append('model', selectedModel);
    body.append('quality', quality);
    body.append('vad', String(useVad && !!health.checks.vadModel));
    body.append('prompt', prompt);
    body.append('media', file);

    try {
      const response = await fetch('/api/transcriptions', { method: 'POST', body });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '无法创建字幕任务');
      setJob(data);
      setMessage('');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '提交任务失败');
    } finally {
      setUploading(false);
    }
  }

  function updateCue(id: string, field: keyof Pick<SubtitleCue, 'start' | 'end' | 'text'>, value: string) {
    setCues((items) => items.map((cue) => cue.id === id ? { ...cue, [field]: value } : cue));
  }

  function addCue() {
    const previousEnd = cues.at(-1)?.end || '00:00:00,000';
    const startMs = timeToMs(previousEnd);
    const start = Number.isFinite(startMs) ? previousEnd : '00:00:00,000';
    const end = msToTime((Number.isFinite(startMs) ? startMs : 0) + 2000);
    setCues((items) => [...items, { id: crypto.randomUUID(), start, end, text: '' }]);
  }

  function insertCueAt(index: number) {
    setCues((items) => {
      const previousEnd = index > 0 ? timeToMs(items[index - 1].end) : Number.NaN;
      const nextStart = index < items.length ? timeToMs(items[index].start) : Number.NaN;
      let startMs = Number.isFinite(previousEnd) ? previousEnd : 0;
      let endMs = startMs + 2000;

      if (Number.isFinite(nextStart)) {
        if (!Number.isFinite(previousEnd)) {
          endMs = nextStart;
          startMs = Math.max(0, nextStart - 2000);
          if (endMs - startMs < 500) endMs = startMs + 2000;
        } else if (nextStart - startMs >= 500) {
          endMs = Math.min(startMs + 2000, nextStart);
        }
      }

      const cue = {
        id: crypto.randomUUID(),
        start: msToTime(startMs),
        end: msToTime(endMs),
        text: '',
      };
      return [...items.slice(0, index), cue, ...items.slice(index)];
    });
  }

  function removeCue(id: string) {
    setCues((items) => items.filter((cue) => cue.id !== id));
  }

  function jumpToCue(cue: SubtitleCue) {
    const startMs = timeToMs(cue.start);
    if (!Number.isFinite(startMs) || !mediaRef.current) return;
    const nextTime = startMs / 1000;
    mediaRef.current.currentTime = nextTime;
    setPlaybackTime(nextTime);
    void mediaRef.current.play().catch(() => undefined);
  }

  function togglePlayback() {
    if (!mediaRef.current) return;
    if (mediaRef.current.paused) void mediaRef.current.play().catch(() => undefined);
    else mediaRef.current.pause();
  }

  function startVideoFrameSampling(video: HTMLVideoElement) {
    if (typeof video.requestVideoFrameCallback !== 'function' || videoFrameRequestRef.current !== null) return;

    const observeFrame: VideoFrameRequestCallback = (_now, metadata) => {
      videoFrameRequestRef.current = null;
      const previousTime = lastVideoFrameTimeRef.current;
      const delta = previousTime === null ? 0 : metadata.mediaTime - previousTime;
      lastVideoFrameTimeRef.current = metadata.mediaTime;

      if (delta > 1 / 240 && delta < 0.2) {
        const samples = frameDurationSamplesRef.current;
        samples.push(delta);
        if (samples.length > 24) samples.shift();
        if (samples.length >= 6) {
          const sorted = [...samples].sort((a, b) => a - b);
          const fps = normalizeFrameRate(1 / sorted[Math.floor(sorted.length / 2)]);
          if (Math.abs((detectedFpsRef.current || 0) - fps) >= 0.01) {
            detectedFpsRef.current = fps;
            setDetectedFps(fps);
            if (!fpsManuallyEditedRef.current) setFpsInput(String(fps));
          }
        }
      }

      if (!video.paused && !video.ended) videoFrameRequestRef.current = video.requestVideoFrameCallback(observeFrame);
    };

    videoFrameRequestRef.current = video.requestVideoFrameCallback(observeFrame);
  }

  function downloadSubtitles(format: 'srt' | 'vtt') {
    const body = cues.map((cue, index) => {
      const start = format === 'vtt' ? cue.start.replace(',', '.') : cue.start.replace('.', ',');
      const end = format === 'vtt' ? cue.end.replace(',', '.') : cue.end.replace('.', ',');
      const block = `${start} --> ${end}\n${cue.text.trim()}`;
      return format === 'srt' ? `${index + 1}\n${block}` : block;
    }).join('\n\n');
    const content = format === 'vtt' ? `WEBVTT\n\n${body}\n` : `${body}\n`;
    const blob = new Blob([content], { type: format === 'vtt' ? 'text/vtt;charset=utf-8' : 'application/x-subrip;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${file?.name.replace(/\.[^.]+$/, '') || 'subtitles'}.${format}`;
    link.click();
    URL.revokeObjectURL(url);
  }

  const isWorking = uploading || (!!job && !['complete', 'error'].includes(job.status));
  const progress = uploading ? 4 : job?.progress || 0;
  const hasInvalidCue = cues.some((cue) => !cueIsValid(cue));
  const isVideo = !!file && (file.type.startsWith('video/') || /\.(mp4|mov|mkv|webm|avi)$/i.test(file.name));
  const recommendedInstalled = models.some((model) => model.id === 'ggml-large-v3-turbo.bin');
  const playbackMs = Math.round(playbackTime * 1000);
  const activeCueIndex = cues.findIndex((cue) => {
    const start = timeToMs(cue.start);
    const end = timeToMs(cue.end);
    return Number.isFinite(start) && Number.isFinite(end) && playbackMs >= start && playbackMs < end;
  });
  const activeCue = activeCueIndex >= 0 ? cues[activeCueIndex] : null;

  useEffect(() => {
    if (!isPlaying || !activeCue) return;
    cueRefs.current.get(activeCue.id)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [activeCue?.id, isPlaying]);

  return (
    <main>
      <nav className="nav">
        <a className="brand" href="/" aria-label="字幕工坊首页"><span className="brand-mark">字</span><span>字幕工坊</span></a>
        <div className="local-badge"><span />仅在本机运行</div>
      </nav>

      <header className="page-head">
        <div><span className="eyebrow">LOCAL SUBTITLE STUDIO</span><h1>生成，然后把每一句<br /><em>调到刚刚好。</em></h1></div>
        <p>选择媒体文件，离线识别语音，在时间轴中校对文字与时间，最后导出字幕。</p>
      </header>

      <section className="studio">
        <aside className="source-panel">
          <div className="panel-heading"><span className="step">01</span><div><h2>媒体文件</h2><small>上传与识别</small></div></div>

          {file && mediaUrl ? (
            <div className={`media-card ${isVideo ? 'video-card' : 'audio-card'}`}>
              <div className="preview-stage">
                {isVideo ? (
                  <video
                    ref={(node) => { mediaRef.current = node; }}
                    src={mediaUrl}
                    controls
                    onTimeUpdate={(event) => setPlaybackTime(event.currentTarget.currentTime)}
                    onLoadedMetadata={(event) => setMediaDuration(Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : 0)}
                    onPlay={(event) => { setIsPlaying(true); startVideoFrameSampling(event.currentTarget); }}
                    onPause={() => setIsPlaying(false)}
                    onEnded={() => setIsPlaying(false)}
                  />
                ) : (
                  <audio
                    ref={(node) => { mediaRef.current = node; }}
                    src={mediaUrl}
                    controls
                    onTimeUpdate={(event) => setPlaybackTime(event.currentTarget.currentTime)}
                    onLoadedMetadata={(event) => setMediaDuration(Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : 0)}
                    onPlay={() => setIsPlaying(true)}
                    onPause={() => setIsPlaying(false)}
                    onEnded={() => setIsPlaying(false)}
                  />
                )}
                {cues.length > 0 && (
                  <div className={`subtitle-overlay ${activeCue ? 'visible' : ''}`} aria-hidden={!activeCue}>
                    {activeCue && <span>{activeCue.text || '（空字幕）'}</span>}
                  </div>
                )}
              </div>
              <div className="playback-controls">
                <button type="button" onClick={() => seekBy(-seekAmountMs)} aria-label={`后退 ${seekAmountLabel}`} aria-keyshortcuts="ArrowLeft">← <span>{seekAmountLabel}</span></button>
                <button type="button" className="play-toggle" onClick={togglePlayback} aria-label={isPlaying ? '暂停' : '播放'}>{isPlaying ? 'Ⅱ' : '▶'}</button>
                <button type="button" onClick={() => seekBy(seekAmountMs)} aria-label={`前进 ${seekAmountLabel}`} aria-keyshortcuts="ArrowRight"><span>{seekAmountLabel}</span> →</button>
                <div className="seek-config">
                  <div className="seek-mode" role="group" aria-label="移动单位">
                    <button type="button" className={seekMode === 'milliseconds' ? 'selected' : ''} onClick={() => setSeekMode('milliseconds')}>毫秒</button>
                    <button type="button" className={seekMode === 'frames' ? 'selected' : ''} onClick={() => setSeekMode('frames')}>按帧</button>
                  </div>
                  {seekMode === 'milliseconds' ? (
                    <label className="seek-step"><span>单次</span><input type="number" min="1" max="60000" step="50" inputMode="numeric" value={seekStepInput} onChange={(event) => setSeekStepInput(event.target.value)} onBlur={() => setSeekStepInput(String(seekStepMs))} aria-label="左右方向键单次移动毫秒数" /><b>ms</b></label>
                  ) : (
                    <>
                      <label className="seek-step frame-count"><span>单次</span><input type="number" min="1" max="100" step="1" inputMode="numeric" value={frameStepInput} onChange={(event) => setFrameStepInput(event.target.value)} onBlur={() => setFrameStepInput(String(frameStep))} aria-label="左右方向键单次移动帧数" /><b>帧</b></label>
                      <label className="seek-step fps-input" title={detectedFps ? `播放时检测到约 ${detectedFps} FPS` : '播放视频后可自动检测'}><span>FPS</span><input type="number" min="1" max="240" step="0.001" inputMode="decimal" value={fpsInput} onChange={(event) => { fpsManuallyEditedRef.current = true; setFpsInput(event.target.value); }} onBlur={() => setFpsInput(String(framesPerSecond))} aria-label="视频帧率" />{detectedFps && <i />}</label>
                    </>
                  )}
                  <small>快捷键&nbsp; ← &nbsp;→</small>
                </div>
              </div>
              {cues.length > 0 && (
                <div className="preview-sync">
                  <span><i className={isPlaying ? 'playing' : ''} />{isPlaying ? '正在同步校对' : '播放视频开始校对'}</span>
                  <time>{msToTime(Math.round(playbackTime * 1000))} / {msToTime(Math.round(mediaDuration * 1000))}</time>
                </div>
              )}
              <div className="file-meta"><strong>{file.name}</strong><span>{formatBytes(file.size)}</span></div>
              <button className="replace-button" onClick={() => inputRef.current?.click()}>更换文件</button>
            </div>
          ) : (
            <div
              className={`dropzone ${dragging ? 'dragging' : ''}`}
              onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
              onDragLeave={() => setDragging(false)}
              onDrop={(event) => { event.preventDefault(); setDragging(false); chooseFile(event.dataTransfer.files[0]); }}
              onClick={() => inputRef.current?.click()}
              role="button"
              tabIndex={0}
              onKeyDown={(event) => event.key === 'Enter' && inputRef.current?.click()}
            >
              <div className="upload-icon"><UploadIcon /></div>
              <strong>拖放媒体文件</strong><span>或点击从电脑选择</span><small>MP4 · MOV · MKV · MP3 · WAV</small>
            </div>
          )}
          <input ref={inputRef} className="file-input" type="file" accept="video/*,audio/*,.mkv,.m4a,.flac" onChange={(event) => chooseFile(event.target.files?.[0])} />

          <div className="setting-grid">
            <label className="field"><span>视频语言</span><select value={language} onChange={(event) => setLanguage(event.target.value)} disabled={isWorking}>{languages.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
            <label className="field"><span>识别质量</span><select value={quality} onChange={(event) => setQuality(event.target.value as typeof quality)} disabled={isWorking}><option value="fast">快速</option><option value="balanced">均衡</option><option value="accurate">高精度</option></select></label>
          </div>
          <label className="field model-field">
            <span>本地模型</span>
            <select value={selectedModel} onChange={(event) => setSelectedModel(event.target.value)} disabled={isWorking || !models.length}>
              {!models.length && <option value="">未找到模型</option>}
              {models.map((model) => <option key={model.id} value={model.id}>{model.label}{model.id === 'ggml-large-v3-turbo.bin' ? ' · 推荐' : ''} · {formatBytes(model.sizeBytes)}</option>)}
            </select>
          </label>
          {!recommendedInstalled && models.length > 0 && <p className="upgrade-note">当前使用 {models.find((model) => model.id === selectedModel)?.label}。安装 large-v3-turbo 可显著提高准确率。</p>}

          <details className="advanced-settings" open>
            <summary>识别增强设置</summary>
            <label className={`toggle-row ${health?.checks.vadModel ? '' : 'disabled'}`}>
              <input type="checkbox" checked={useVad} onChange={(event) => setUseVad(event.target.checked)} disabled={!health?.checks.vadModel || isWorking} />
              <span><strong>实验性静音过滤（默认关闭）</strong><small>{health?.checks.vadModel ? '只建议用于人声清晰的录音；背景音乐可能造成漏字或时间偏移' : '需要先下载 VAD 模型'}</small></span>
            </label>
            <label className="field prompt-field"><span>术语、人名和品牌词</span><textarea value={prompt} maxLength={500} onChange={(event) => setPrompt(event.target.value)} disabled={isWorking} placeholder="例如：字幕工坊、OpenAI、产品名称…" /><small>作为识别提示，不会发送到网络</small></label>
          </details>

          <button className="primary" disabled={!file || !health?.ready || !selectedModel || isWorking} onClick={startTranscription}><span>{isWorking ? '正在处理' : '生成高质量字幕'}</span><b>→</b></button>

          {(isWorking || job) && (
            <div className={`job-card ${job?.status === 'error' ? 'error' : ''}`}>
              <div className="job-line"><div><small>当前任务</small><strong>{uploading ? '正在读取文件' : job?.message}</strong></div><b>{progress}%</b></div>
              <div className="progress"><i style={{ width: `${progress}%` }} /></div>
              {job?.error && <pre>{job.error}</pre>}
            </div>
          )}
          {message && <p className="notice">{message}</p>}

          <div className="health-strip">
            {health ? Object.entries(health.checks).map(([name, ok]) => <span key={name} className={ok ? 'ready' : 'missing'}>{ok ? '✓' : '!'} {name === 'model' ? '模型' : name === 'vadModel' ? 'VAD' : name}</span>) : <span className="missing">! 本地服务</span>}
            <button onClick={loadHealth}>检测</button>
          </div>
          {health && (!health.ready || !recommendedInstalled) && <p className="setup-note">安装推荐模型（包含可选 VAD）：<code>npm run setup:model</code></p>}
        </aside>

        <section className="editor-panel">
          <div className="editor-head">
            <div className="panel-heading"><span className="step">02</span><div><h2>字幕时间轴</h2><small>{cues.length ? `${cues.length} 条字幕 · 可直接编辑` : '等待生成字幕'}</small></div></div>
            <div className="editor-actions">
              <button className="add-button" onClick={addCue} disabled={!file}>＋ 末尾新增</button>
              <button onClick={() => downloadSubtitles('srt')} disabled={!cues.length || hasInvalidCue}>导出 SRT</button>
              <button onClick={() => downloadSubtitles('vtt')} disabled={!cues.length || hasInvalidCue}>导出 VTT</button>
            </div>
          </div>

          {cues.length ? (
            <div className="timeline">
              {cues.map((cue, index) => (
                <Fragment key={cue.id}>
                  <button type="button" className="insert-cue" onClick={() => insertCueAt(index)} aria-label={`在第 ${index + 1} 条字幕前插入新字幕`}><i /><span>＋ 在这里插入字幕</span><i /></button>
                  <article
                    className={`cue ${cueIsValid(cue) ? '' : 'invalid'} ${activeCueIndex === index ? 'active' : ''}`}
                    ref={(node) => { if (node) cueRefs.current.set(cue.id, node); else cueRefs.current.delete(cue.id); }}
                  >
                    <button type="button" className="cue-index" onClick={() => jumpToCue(cue)} title="跳到这条字幕并播放" aria-label={`跳到第 ${index + 1} 条字幕并播放`}><span>{String(index + 1).padStart(2, '0')}</span><i /></button>
                    <div className="cue-body">
                      <div className="time-row">
                        <label><span>开始</span><input aria-label={`第 ${index + 1} 条开始时间`} value={cue.start} onChange={(event) => updateCue(cue.id, 'start', event.target.value)} /></label>
                        <b>→</b>
                        <label><span>结束</span><input aria-label={`第 ${index + 1} 条结束时间`} value={cue.end} onChange={(event) => updateCue(cue.id, 'end', event.target.value)} /></label>
                        <button className="delete-button" aria-label={`删除第 ${index + 1} 条字幕`} onClick={() => removeCue(cue.id)}>×</button>
                      </div>
                      <textarea aria-label={`第 ${index + 1} 条字幕文字`} value={cue.text} onChange={(event) => updateCue(cue.id, 'text', event.target.value)} placeholder="输入字幕文字…" />
                      {!cueIsValid(cue) && <small className="time-error">时间格式应为 00:00:00,000，且结束时间不能早于开始时间</small>}
                    </div>
                  </article>
                </Fragment>
              ))}
              <button className="append-cue" onClick={addCue}>＋ 在结尾添加字幕</button>
            </div>
          ) : (
            <div className="editor-empty">
              <div className="empty-lines"><i /><i /><i /></div>
              <strong>{isWorking ? '正在生成时间轴…' : '字幕条目将在这里出现'}</strong>
              <p>生成后可以逐条修改开始时间、结束时间和字幕文字。</p>
            </div>
          )}
        </section>
      </section>

      <footer><span>媒体与编辑内容始终留在这台电脑上。</span><span>Powered locally by whisper.cpp</span></footer>
    </main>
  );
}
