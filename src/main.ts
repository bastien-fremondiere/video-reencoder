import { createWritableStream, StreamWritable } from './streamSaver';
import { StreamInfo, WorkerProgressMessage, WorkerToMainMessage } from './workers/pipeline.worker';

// UI DOM Elements
const dropZone = document.getElementById('drop-zone') as HTMLElement;
const fileInput = document.getElementById('file-input') as HTMLInputElement;
const selectBtn = document.getElementById('select-btn') as HTMLButtonElement;

const processCard = document.getElementById('process-card') as HTMLElement;
const fileNameEl = document.getElementById('file-name') as HTMLElement;
const fileSizeEl = document.getElementById('file-size') as HTMLElement;
const modeBadge = document.getElementById('processing-mode-badge') as HTMLElement;
const compatWarning = document.getElementById('compat-warning') as HTMLElement;

const audioTrackSelect = document.getElementById('audio-track-select') as HTMLSelectElement;
const subtitleTrackSelect = document.getElementById('subtitle-track-select') as HTMLSelectElement;
const subFileInput = document.getElementById('sub-file-input') as HTMLInputElement;
const externalSubName = document.getElementById('external-sub-name') as HTMLElement;

const startBtn = document.getElementById('start-btn') as HTMLButtonElement;
const resetBtn = document.getElementById('reset-btn') as HTMLButtonElement;

const progressContainer = document.getElementById('progress-container') as HTMLElement;
const progressBarFill = document.getElementById('progress-bar-fill') as HTMLElement;
const progressPercent = document.getElementById('progress-percent') as HTMLElement;

const statFps = document.getElementById('stat-fps') as HTMLElement;
const statSpeed = document.getElementById('stat-speed') as HTMLElement;
const statBitrate = document.getElementById('stat-bitrate') as HTMLElement;
const statEta = document.getElementById('stat-eta') as HTMLElement;

const logConsole = document.getElementById('log-console') as HTMLElement;
const clearLogsBtn = document.getElementById('clear-logs-btn') as HTMLButtonElement;

// Compare Section DOM Elements
const compareSection = document.getElementById('compare-section') as HTMLElement;
const sourceFormatLabel = document.getElementById('source-format-label') as HTMLElement;
const sourcePreview = document.getElementById('source-preview') as HTMLVideoElement;
const convertedWrapper = document.getElementById('converted-wrapper') as HTMLElement;
const convertedPreview = document.getElementById('converted-preview') as HTMLVideoElement;
const compareDivider = document.getElementById('compare-divider') as HTMLElement;
const compareSlider = document.getElementById('compare-slider') as HTMLInputElement;

const comparePlayBtn = document.getElementById('compare-play-btn') as HTMLButtonElement;
const compareTimeline = document.getElementById('compare-timeline') as HTMLInputElement;
const compareTime = document.getElementById('compare-time') as HTMLElement;
const audioConvertedBtn = document.getElementById('audio-converted-btn') as HTMLButtonElement;
const audioSourceBtn = document.getElementById('audio-source-btn') as HTMLButtonElement;
const downloadBtn = document.getElementById('download-btn') as HTMLAnchorElement;

let selectedFile: File | null = null;
let externalSubtitleContent: string | undefined = undefined;
let activeWorker: Worker | null = null;
let activeWritableStream: StreamWritable | null = null;
let outputChunks: Uint8Array[] = [];

// Detect WebCodecs VideoEncoder support
const supportsWebCodecsVideo = typeof (window as any).VideoEncoder !== 'undefined';
if (!supportsWebCodecsVideo && compatWarning) {
  compatWarning.classList.remove('hidden');
}

// Log helper
function appendLog(level: 'info' | 'warn' | 'error' | 'success', message: string) {
  const time = new Date().toLocaleTimeString();
  const entry = document.createElement('div');
  entry.className = `log-entry log-${level}`;
  entry.textContent = `[${time}] ${message}`;
  logConsole.appendChild(entry);
  logConsole.scrollTop = logConsole.scrollHeight;
}

clearLogsBtn.addEventListener('click', (e) => {
  e.preventDefault();
  e.stopPropagation();
  logConsole.innerHTML = '';
});

// File selection handlers
selectBtn.addEventListener('click', () => fileInput.click());

fileInput.addEventListener('change', () => {
  if (fileInput.files && fileInput.files.length > 0) {
    handleFileSelected(fileInput.files[0]);
  }
});

dropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropZone.classList.add('dragover');
});

dropZone.addEventListener('dragleave', () => {
  dropZone.classList.remove('dragover');
});

dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('dragover');
  if (e.dataTransfer && e.dataTransfer.files.length > 0) {
    handleFileSelected(e.dataTransfer.files[0]);
  }
});

subFileInput.addEventListener('change', async () => {
  if (subFileInput.files && subFileInput.files.length > 0) {
    const file = subFileInput.files[0];
    try {
      externalSubtitleContent = await file.text();
      externalSubName.textContent = `✓ ${file.name}`;
      externalSubName.classList.remove('hidden');

      let extOpt = subtitleTrackSelect.querySelector('option[value="external"]') as HTMLOptionElement;
      if (!extOpt) {
        extOpt = document.createElement('option');
        extOpt.value = 'external';
        subtitleTrackSelect.appendChild(extOpt);
      }
      extOpt.textContent = `Incruster sous-titre externe (${file.name})`;
      subtitleTrackSelect.value = 'external';

      appendLog('info', `Fichier sous-titres importé: ${file.name}`);
    } catch (err: any) {
      appendLog('error', `Erreur lecture sous-titres: ${err?.message || err}`);
    }
  }
});

resetBtn.addEventListener('click', () => {
  if (activeWorker) {
    activeWorker.terminate();
    activeWorker = null;
  }
  selectedFile = null;
  externalSubtitleContent = undefined;
  outputChunks = [];
  fileInput.value = '';
  subFileInput.value = '';
  externalSubName.textContent = '';
  externalSubName.classList.add('hidden');
  audioTrackSelect.innerHTML = '<option value="-1">Détection automatique...</option>';
  subtitleTrackSelect.innerHTML = '<option value="none">Aucun (Pas de sous-titres)</option>';
  processCard.classList.add('hidden');
  compareSection.classList.add('hidden');
  dropZone.classList.remove('hidden');
  progressContainer.classList.add('hidden');
  modeBadge.classList.add('hidden');
  startBtn.disabled = false;
  sourcePreview.src = '';
  convertedPreview.src = '';
  appendLog('info', 'Fichier réinitialisé.');
});

function handleFileSelected(file: File) {
  selectedFile = file;
  fileNameEl.textContent = file.name;
  fileSizeEl.textContent = `${(file.size / (1024 * 1024)).toFixed(2)} Mo`;

  const ext = file.name.split('.').pop()?.toUpperCase() || 'SOURCE';
  sourceFormatLabel.textContent = ext;

  const sourceUrl = URL.createObjectURL(file);
  sourcePreview.src = sourceUrl;

  dropZone.classList.add('hidden');
  processCard.classList.remove('hidden');
  appendLog('info', `Fichier chargé: ${file.name}`);

  // Inspect file tracks with background worker
  inspectContainerTracks(file);
}

function inspectContainerTracks(file: File) {
  appendLog('info', 'Analyse rapide des pistes audio et sous-titres...');
  const inspectWorker = new Worker(new URL('./workers/pipeline.worker.ts', import.meta.url), {
    type: 'module',
  });

  inspectWorker.onmessage = (e: MessageEvent<WorkerToMainMessage>) => {
    const data = e.data;
    if (data.type === 'INSPECT_RESULT') {
      populateTrackSelectors(data.streams);
      inspectWorker.terminate();
    } else if (data.type === 'LOG') {
      appendLog(data.level, data.message);
    }
  };

  inspectWorker.postMessage({ type: 'INSPECT', file });
}

function populateTrackSelectors(streams: StreamInfo[]) {
  const audioStreams = streams.filter((s) => s.type === 'audio');
  const subStreams = streams.filter((s) => s.type === 'subtitle');

  // Populate Audio Select
  audioTrackSelect.innerHTML = '';
  if (audioStreams.length === 0) {
    audioTrackSelect.innerHTML = '<option value="-1">Aucune piste audio détectée</option>';
  } else {
    audioStreams.forEach((s) => {
      const opt = document.createElement('option');
      opt.value = s.index.toString();
      const langUpper = (s.language || 'und').toUpperCase();
      const titleStr = s.title ? ` (${s.title})` : '';
      const codecStr = s.codecName.toUpperCase();
      opt.textContent = `Piste ${s.index}: [${langUpper}] ${codecStr} - ${s.channels || 2} ch${titleStr}`;
      audioTrackSelect.appendChild(opt);
    });
  }

  // Populate Subtitle Select
  subtitleTrackSelect.innerHTML = '<option value="none">Aucun (Pas de sous-titres)</option>';
  if (externalSubtitleContent) {
    const extOpt = document.createElement('option');
    extOpt.value = 'external';
    extOpt.textContent = 'Sous-titre externe (.srt / .vtt)';
    extOpt.selected = true;
    subtitleTrackSelect.appendChild(extOpt);
  }

  subStreams.forEach((s) => {
    const opt = document.createElement('option');
    opt.value = s.index.toString();
    const langUpper = (s.language || 'und').toUpperCase();
    const titleStr = s.title ? ` (${s.title})` : '';
    opt.textContent = `Incruster Piste ${s.index}: [${langUpper}] ${s.codecName.toUpperCase()}${titleStr}`;
    subtitleTrackSelect.appendChild(opt);
  });

  appendLog('success', `Pistes détectées: ${audioStreams.length} audio, ${subStreams.length} sous-titres.`);
}

function formatETA(seconds: number): string {
  if (!seconds || !isFinite(seconds) || seconds < 0) return '--:--';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

function formatTime(sec: number): string {
  if (isNaN(sec) || !isFinite(sec)) return '00:00';
  const mins = Math.floor(sec / 60);
  const secs = Math.floor(sec % 60);
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

// Split-screen comparison slider handler
compareSlider.addEventListener('input', () => {
  const val = Number(compareSlider.value);
  convertedWrapper.style.clipPath = `inset(0 0 0 ${val}%)`;
  compareDivider.style.left = `${val}%`;
});

// Synchronized video playback controls
comparePlayBtn.addEventListener('click', () => {
  if (convertedPreview.paused) {
    sourcePreview.play().catch(() => {});
    convertedPreview.play().catch(() => {});
    comparePlayBtn.textContent = '❚❚ Pause';
  } else {
    sourcePreview.pause();
    convertedPreview.pause();
    comparePlayBtn.textContent = '▶ Lecture';
  }
});

convertedPreview.addEventListener('timeupdate', () => {
  if (!convertedPreview.duration) return;
  const progressPercent = (convertedPreview.currentTime / convertedPreview.duration) * 100;
  compareTimeline.value = progressPercent.toString();
  compareTime.textContent = `${formatTime(convertedPreview.currentTime)} / ${formatTime(convertedPreview.duration)}`;
});

compareTimeline.addEventListener('input', () => {
  if (!convertedPreview.duration) return;
  const seekTime = (Number(compareTimeline.value) / 100) * convertedPreview.duration;
  sourcePreview.currentTime = seekTime;
  convertedPreview.currentTime = seekTime;
});

// Audio track switching in comparator
audioConvertedBtn.addEventListener('click', () => {
  audioConvertedBtn.classList.add('active');
  audioSourceBtn.classList.remove('active');
  convertedPreview.muted = false;
  sourcePreview.muted = true;
});

audioSourceBtn.addEventListener('click', () => {
  audioSourceBtn.classList.add('active');
  audioConvertedBtn.classList.remove('active');
  sourcePreview.muted = false;
  convertedPreview.muted = true;
});

// Start conversion pipeline
startBtn.addEventListener('click', async () => {
  if (!selectedFile) return;

  outputChunks = [];
  const outputFilename = selectedFile.name.replace(/\.[^/.]+$/, '') + '_converted.mp4';

  const selectedAudioIndex = parseInt(audioTrackSelect.value, 10);
  let selectedSubtitleIndex: number | undefined = undefined;
  if (subtitleTrackSelect.value !== 'none' && subtitleTrackSelect.value !== 'external') {
    selectedSubtitleIndex = parseInt(subtitleTrackSelect.value, 10);
  }

  try {
    startBtn.disabled = true;
    appendLog('info', 'Initialisation du flux de sortie zéro-RAM...');

    activeWritableStream = await createWritableStream(outputFilename);
    appendLog('success', 'Destination de sortie prête.');

    progressContainer.classList.remove('hidden');
    progressBarFill.style.width = '0%';
    progressPercent.textContent = '0%';

    activeWorker = new Worker(new URL('./workers/pipeline.worker.ts', import.meta.url), {
      type: 'module',
    });

    activeWorker.onmessage = async (e: MessageEvent<WorkerToMainMessage>) => {
      const data = e.data;

      if (data.type === 'LOG') {
        appendLog(data.level, data.message);
      } else if (data.type === 'PROGRESS') {
        const pMsg = data as WorkerProgressMessage;
        progressBarFill.style.width = `${pMsg.percent}%`;
        progressPercent.textContent = `${pMsg.percent}%`;

        statFps.textContent = `${pMsg.fps}`;
        statSpeed.textContent = `${pMsg.speed}x`;
        statBitrate.textContent = `${pMsg.bitrateMBs} Mo/s`;
        statEta.textContent = formatETA(pMsg.etaSeconds);

        modeBadge.classList.remove('hidden');
        if (pMsg.mode === 'COPY') {
          modeBadge.textContent = 'Mode Copie Directe (Passthrough)';
          modeBadge.className = 'badge badge-mode';
        } else {
          modeBadge.textContent = 'Mode Réencodage GPU (H.264)';
          modeBadge.className = 'badge badge-mode transcode';
        }
      } else if (data.type === 'CHUNK') {
        const chunkArray = new Uint8Array(data.chunk);
        if (activeWritableStream) {
          await activeWritableStream.write(chunkArray);
          // If not writing directly to disk via File System Access API, keep chunk for Blob creation
          if (!activeWritableStream.isDirectDisk) {
            outputChunks.push(chunkArray);
          }
        } else {
          outputChunks.push(chunkArray);
        }
      } else if (data.type === 'DONE') {
        let convertedUrl = '';
        if (activeWritableStream) {
          await activeWritableStream.close();
          if (activeWritableStream.getBlobUrl) {
            convertedUrl = await activeWritableStream.getBlobUrl();
          }
          activeWritableStream = null;
        }
        progressBarFill.style.width = '100%';
        progressPercent.textContent = '100%';
        appendLog('success', '🎉 Conversion et écriture sur disque réussies !');

        if (!convertedUrl && outputChunks.length > 0) {
          const blob = new Blob(outputChunks as BlobPart[], { type: 'video/mp4' });
          convertedUrl = URL.createObjectURL(blob);
        }

        if (convertedUrl) {
          convertedPreview.src = convertedUrl;
          downloadBtn.href = convertedUrl;
          downloadBtn.download = outputFilename;
        }

        // Default: play converted audio
        convertedPreview.muted = false;
        sourcePreview.muted = true;

        compareSection.classList.remove('hidden');

        if (activeWorker) {
          activeWorker.terminate();
          activeWorker = null;
        }
      } else if (data.type === 'ERROR') {
        if (activeWritableStream) {
          await activeWritableStream.close();
          activeWritableStream = null;
        }
        appendLog('error', `Échec du traitement: ${data.error}`);
        startBtn.disabled = false;
        if (activeWorker) {
          activeWorker.terminate();
          activeWorker = null;
        }
      }
    };

    activeWorker.postMessage({
      type: 'START',
      file: selectedFile,
      selectedAudioIndex: selectedAudioIndex >= 0 ? selectedAudioIndex : undefined,
      selectedSubtitleIndex,
      externalSubtitleContent: subtitleTrackSelect.value === 'external' ? externalSubtitleContent : undefined,
    });
  } catch (err: any) {
    appendLog('error', `Impossible de démarrer: ${err.message || err}`);
    startBtn.disabled = false;
  }
});
