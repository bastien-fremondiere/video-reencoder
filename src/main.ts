import './style.css';
import { createWritableStream, StreamWritable } from './streamSaver';
import { WorkerStartMessage, WorkerToMainMessage } from './workers/pipeline.worker';

// UI DOM Elements
const dropZone = document.getElementById('drop-zone') as HTMLElement;
const fileInput = document.getElementById('file-input') as HTMLInputElement;
const selectBtn = document.getElementById('select-btn') as HTMLButtonElement;

const processCard = document.getElementById('process-card') as HTMLElement;
const fileNameEl = document.getElementById('file-name') as HTMLElement;
const fileSizeEl = document.getElementById('file-size') as HTMLElement;
const modeBadge = document.getElementById('processing-mode-badge') as HTMLElement;

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

let selectedFile: File | null = null;
let activeWorker: Worker | null = null;
let activeWritableStream: StreamWritable | null = null;

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

resetBtn.addEventListener('click', () => {
  if (activeWorker) {
    activeWorker.terminate();
    activeWorker = null;
  }
  selectedFile = null;
  fileInput.value = '';
  processCard.classList.add('hidden');
  dropZone.classList.remove('hidden');
  progressContainer.classList.add('hidden');
  modeBadge.classList.add('hidden');
  startBtn.disabled = false;
  appendLog('info', 'Fichier réinitialisé.');
});

function handleFileSelected(file: File) {
  selectedFile = file;
  fileNameEl.textContent = file.name;
  fileSizeEl.textContent = `${(file.size / (1024 * 1024)).toFixed(2)} Mo`;

  dropZone.classList.add('hidden');
  processCard.classList.remove('hidden');
  appendLog('info', `Fichier chargé: ${file.name}`);
}

function formatETA(seconds: number): string {
  if (!seconds || !isFinite(seconds) || seconds < 0) return '--:--';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

// Start conversion pipeline
startBtn.addEventListener('click', async () => {
  if (!selectedFile) return;

  const outputFilename = selectedFile.name.replace(/\.[^/.]+$/, '') + '_converted.mp4';

  try {
    startBtn.disabled = true;
    appendLog('info', 'Initialisation du flux de sortie zéro-RAM...');

    // Prompt user for save file / initialize SW stream
    activeWritableStream = await createWritableStream(outputFilename);
    appendLog('success', 'Destination de sortie prête.');

    progressContainer.classList.remove('hidden');
    progressBarFill.style.width = '0%';
    progressPercent.textContent = '0%';

    // Instantiate pipeline Web Worker
    activeWorker = new Worker(new URL('./workers/pipeline.worker.ts', import.meta.url), {
      type: 'module',
    });

    activeWorker.onmessage = async (e: MessageEvent<WorkerToMainMessage>) => {
      const data = e.data;

      if (data.type === 'LOG') {
        appendLog(data.level, data.message);
      } else if (data.type === 'PROGRESS') {
        progressBarFill.style.width = `${data.percent}%`;
        progressPercent.textContent = `${data.percent}%`;

        statFps.textContent = `${data.fps}`;
        statSpeed.textContent = `${data.speed}x`;
        statBitrate.textContent = `${data.bitrateMBs} Mo/s`;
        statEta.textContent = formatETA(data.etaSeconds);

        modeBadge.classList.remove('hidden');
        if (data.mode === 'COPY') {
          modeBadge.textContent = 'Mode Copie Directe (Passthrough)';
          modeBadge.className = 'badge badge-mode';
        } else {
          modeBadge.textContent = 'Mode Réencodage GPU (H.264)';
          modeBadge.className = 'badge badge-mode transcode';
        }
      } else if (data.type === 'CHUNK') {
        if (activeWritableStream) {
          await activeWritableStream.write(new Uint8Array(data.chunk));
        }
      } else if (data.type === 'DONE') {
        if (activeWritableStream) {
          await activeWritableStream.close();
          activeWritableStream = null;
        }
        progressBarFill.style.width = '100%';
        progressPercent.textContent = '100%';
        appendLog('success', '🎉 Conversion et écriture sur disque réussies !');
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

    // Send start message
    const startMsg: WorkerStartMessage = {
      type: 'START',
      file: selectedFile,
    };
    activeWorker.postMessage(startMsg);
  } catch (err: any) {
    appendLog('error', `Impossible de démarrer: ${err.message || err}`);
    startBtn.disabled = false;
  }
});
