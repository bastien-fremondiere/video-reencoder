import LibAV from 'libav.js';
import * as MP4Muxer from 'mp4-muxer';

export interface StreamInfo {
  index: number;
  type: 'video' | 'audio' | 'subtitle' | 'unknown';
  codecId: number;
  codecName: string;
  language: string;
  title: string;
  width?: number;
  height?: number;
  channels?: number;
  sampleRate?: number;
}

export interface WorkerStartMessage {
  type: 'START';
  file: File;
  selectedAudioIndex?: number; // Stream index for audio
  selectedSubtitleIndex?: number; // Stream index for subtitle burn-in
  externalSubtitleContent?: string; // External SRT or WebVTT string
}

export interface WorkerInspectMessage {
  type: 'INSPECT';
  file: File;
}

export interface WorkerInspectResultMessage {
  type: 'INSPECT_RESULT';
  streams: StreamInfo[];
}

export interface WorkerProgressMessage {
  type: 'PROGRESS';
  percent: number;
  fps: number;
  speed: number;
  bitrateMBs: number;
  etaSeconds: number;
  mode: 'COPY' | 'TRANSCODE';
}

export interface WorkerLogMessage {
  type: 'LOG';
  level: 'info' | 'warn' | 'error' | 'success';
  message: string;
}

export interface WorkerChunkMessage {
  type: 'CHUNK';
  chunk: ArrayBuffer;
}

export interface WorkerDoneMessage {
  type: 'DONE';
}

export interface WorkerErrorMessage {
  type: 'ERROR';
  error: string;
}

export type WorkerToMainMessage =
  | WorkerInspectResultMessage
  | WorkerProgressMessage
  | WorkerLogMessage
  | WorkerChunkMessage
  | WorkerDoneMessage
  | WorkerErrorMessage;

function log(level: 'info' | 'warn' | 'error' | 'success', message: string) {
  postMessage({ type: 'LOG', level, message } as WorkerLogMessage);
}

function emitChunk(chunk: Uint8Array) {
  const buffer = chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength);
  postMessage({ type: 'CHUNK', chunk: buffer } as WorkerChunkMessage, [buffer]);
}

interface SubtitleCue {
  start: number;
  end: number;
  text: string;
}

function parseSRTorVTT(content: string): SubtitleCue[] {
  const cues: SubtitleCue[] = [];
  const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/^WEBVTT[^\n]*\n+/i, '');
  const blocks = normalized.split(/\n\s*\n/);

  function timeToSec(t: string): number {
    const parts = t.trim().replace(',', '.').split(':');
    if (parts.length === 3) {
      const hours = parseFloat(parts[0]);
      const minutes = parseFloat(parts[1]);
      const seconds = parseFloat(parts[2]);
      return hours * 3600 + minutes * 60 + seconds;
    }
    return 0;
  }

  for (const block of blocks) {
    const lines = block.trim().split('\n');
    if (lines.length < 2) continue;

    let timeLineIndex = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes('-->')) {
        timeLineIndex = i;
        break;
      }
    }
    if (timeLineIndex === -1) continue;

    const timeLine = lines[timeLineIndex];
    const [startStr, endStr] = timeLine.split('-->');
    if (!startStr || !endStr) continue;

    const start = timeToSec(startStr.trim().split(' ')[0]);
    const end = timeToSec(endStr.trim().split(' ')[0]);

    const textLines = lines.slice(timeLineIndex + 1);
    const cleanText = textLines
      .join('\n')
      .replace(/<[^>]*>/g, '')
      .replace(/\{[^}]*\}/g, '')
      .trim();

    if (cleanText && end > start) {
      cues.push({ start, end, text: cleanText });
    }
  }

  return cues;
}

function mapLibavCodecToWebCodecs(codecId: number | string, codecName?: string): string {
  const name = (codecName || '').toLowerCase();

  // AV1: 222 in libav / FFmpeg
  if (name.includes('av1') || codecId === 222 || codecId === 225 || codecId === 'av1') {
    return 'av01.0.08M.08';
  }
  // HEVC / H.265: 173 in FFmpeg
  if (name.includes('hevc') || name.includes('h265') || codecId === 173 || codecId === 'hevc') {
    return 'hev1.1.6.L93.B0';
  }
  // VP9: 167 in FFmpeg
  if (name.includes('vp9') || codecId === 167 || codecId === 'vp9') {
    return 'vp09.00.10.08';
  }
  // VP8: 139 in FFmpeg
  if (name.includes('vp8') || codecId === 139 || codecId === 'vp8') {
    return 'vp8';
  }
  return 'avc1.4d401f';
}

self.onmessage = async (e: MessageEvent<WorkerStartMessage | WorkerInspectMessage>) => {
  if (e.data.type === 'INSPECT') {
    try {
      const streams = await inspectFile(e.data.file);
      postMessage({ type: 'INSPECT_RESULT', streams } as WorkerInspectResultMessage);
    } catch (err: any) {
      log('error', `Échec d'inspection: ${err?.message || err}`);
    }
    return;
  }

  if (e.data.type !== 'START') return;

  const { file, selectedAudioIndex, selectedSubtitleIndex, externalSubtitleContent } = e.data;
  log('info', `Début du traitement de "${file.name}" (${(file.size / (1024 * 1024)).toFixed(2)} Mo)`);

  try {
    await processVideoFile(file, selectedAudioIndex, selectedSubtitleIndex, externalSubtitleContent);
    postMessage({ type: 'DONE' } as WorkerDoneMessage);
  } catch (err: any) {
    const errorMsg = err && err.stack ? `${err.name || 'Error'}: ${err.message || err}\n${err.stack}` : String(err?.message || err);
    log('error', `Erreur de traitement: ${errorMsg}`);
    postMessage({ type: 'ERROR', error: errorMsg } as WorkerErrorMessage);
  }
};

async function getLibavInstance() {
  let base = new URL('../libav/', import.meta.url).href;
  if (!base.endsWith('/')) {
    base += '/';
  }
  return await LibAV.LibAV({
    noworker: true,
    variant: 'webcodecs',
    base,
    toImport: `${base}libav-6.10.9.0-webcodecs.wasm.mjs`,
  });
}

async function inspectFile(file: File): Promise<StreamInfo[]> {
  const libav = await getLibavInstance();
  const filename = `inspect_${Date.now()}_${file.name}`;

  // Stream slices on demand via block reader device (Zero-OOM)
  (libav as any).onblockread = async (name: string, pos: number, length: number) => {
    try {
      const slice = file.slice(pos, pos + length);
      const ab = await slice.arrayBuffer();
      await (libav as any).ff_block_reader_dev_send(name, pos, new Uint8Array(ab));
    } catch (e) {
      console.error('Error onblockread (inspect):', e);
    }
  };

  await (libav as any).mkblockreaderdev(filename, file.size);

  const [fmt_ctx, streams] = await libav.ff_init_demuxer_file(filename);
  const streamInfos: StreamInfo[] = [];

  for (const s of streams) {
    const codecName = await libav.avcodec_get_name(s.codec_id);
    let type: StreamInfo['type'] = 'unknown';
    if (s.codec_type === 0) type = 'video';
    else if (s.codec_type === 1) type = 'audio';
    else if (s.codec_type === 3) type = 'subtitle';

    const lang = s.metadata?.language || 'und';
    const title = s.metadata?.title || s.metadata?.handler_name || '';

    const info: StreamInfo = {
      index: s.index,
      type,
      codecId: s.codec_id,
      codecName: codecName || `codec_${s.codec_id}`,
      language: lang,
      title: title.trim(),
    };

    if (s.codecpar) {
      if (type === 'video') {
        info.width = await (libav as any).AVCodecParameters_width(s.codecpar);
        info.height = await (libav as any).AVCodecParameters_height(s.codecpar);
      } else if (type === 'audio') {
        info.sampleRate = await (libav as any).AVCodecParameters_sample_rate(s.codecpar);
        try {
          info.channels = await (libav as any).AVCodecParameters_ch_layout_nb_channels(s.codecpar);
        } catch {
          info.channels = 2;
        }
      }
    }

    streamInfos.push(info);
  }

  await libav.avformat_close_input_js(fmt_ctx);
  await libav.unlink(filename);
  return streamInfos;
}

async function processVideoFile(
  file: File,
  selectedAudioIndex?: number,
  selectedSubtitleIndex?: number,
  externalSubtitleContent?: string
) {
  log('info', 'Chargement du module WASM libav.js (variante webcodecs)...');
  const libav = await getLibavInstance();

  const filename = `input_${Date.now()}_${file.name || 'video.mkv'}`;

  log('info', 'Initialisation du lecteur de flux continu (Streaming Zéro-RAM)...');
  (libav as any).onblockread = async (name: string, pos: number, length: number) => {
    try {
      const slice = file.slice(pos, pos + length);
      const ab = await slice.arrayBuffer();
      await (libav as any).ff_block_reader_dev_send(name, pos, new Uint8Array(ab));
    } catch (e) {
      console.error('Error onblockread (pipeline):', e);
    }
  };

  await (libav as any).mkblockreaderdev(filename, file.size);

  log('info', 'Ouverture du fichier et analyse des flux...');
  const [fmt_ctx, streams] = await libav.ff_init_demuxer_file(filename);

  let videoStreamIndex = -1;
  let audioStreamIndex = -1;
  let subtitleStreamIndex = -1;

  let videoStream: any = null;
  let audioStream: any = null;
  let subtitleStream: any = null;

  for (let i = 0; i < streams.length; i++) {
    const s: any = streams[i];
    if (s.codecpar) {
      s.width = await (libav as any).AVCodecParameters_width(s.codecpar);
      s.height = await (libav as any).AVCodecParameters_height(s.codecpar);
      s.sample_rate = await (libav as any).AVCodecParameters_sample_rate(s.codecpar);
      try {
        s.channels = await (libav as any).AVCodecParameters_ch_layout_nb_channels(s.codecpar);
      } catch {
        s.channels = 2;
      }
      const extradataSize = await (libav as any).AVCodecParameters_extradata_size(s.codecpar);
      const extradataPtr = await (libav as any).AVCodecParameters_extradata(s.codecpar);
      if (extradataSize > 0 && extradataPtr) {
        s.extradata = await (libav as any).copyout_u8(extradataPtr, extradataSize);
      }
    }

    if (s.codec_type === 0 && videoStreamIndex === -1) {
      videoStreamIndex = i;
      videoStream = s;
    } else if (s.codec_type === 1) {
      if (selectedAudioIndex !== undefined && selectedAudioIndex >= 0) {
        if (s.index === selectedAudioIndex) {
          audioStreamIndex = i;
          audioStream = s;
        }
      } else if (audioStreamIndex === -1) {
        audioStreamIndex = i;
        audioStream = s;
      }
    } else if (s.codec_type === 3) {
      if (selectedSubtitleIndex !== undefined && selectedSubtitleIndex >= 0) {
        if (s.index === selectedSubtitleIndex) {
          subtitleStreamIndex = i;
          subtitleStream = s;
        }
      }
    }
  }

  if (videoStreamIndex === -1) {
    throw new Error('Aucun flux vidéo trouvé dans le fichier d\'entrée.');
  }

  const durationSec = videoStream.duration_time || (file.size / 1000000) * 0.5;
  log('info', `Flux vidéo détecté [Index ${videoStreamIndex}]: Codec ID ${videoStream.codec_id}, ${videoStream.width}x${videoStream.height}`);
  if (audioStream) {
    log('info', `Flux audio sélectionné [Index ${audioStream.index}]: Codec ID ${audioStream.codec_id}, ${audioStream.channels} canaux, ${audioStream.sample_rate} Hz`);
  }

  const isH264 = videoStream.codec_id === 27 || videoStream.codec_id === 'h264' || videoStream.codec_name === 'h264';
  const isAAC = audioStream && (audioStream.codec_id === 86018 || audioStream.codec_id === 'aac' || audioStream.codec_name === 'aac');

  // Subtitle cues setup
  const subtitleCues: SubtitleCue[] = [];
  if (externalSubtitleContent) {
    subtitleCues.push(...parseSRTorVTT(externalSubtitleContent));
    log('info', `Sous-titre externe chargé: ${subtitleCues.length} répliques trouvées.`);
  }

  const burnInSubtitles = subtitleCues.length > 0 || subtitleStreamIndex >= 0;

  // Video passthrough is possible ONLY if H.264 AND NO subtitle burn-in requested
  const videoPassthrough = isH264 && !burnInSubtitles;
  const audioPassthrough = audioStream ? isAAC : false;
  const mode: 'COPY' | 'TRANSCODE' = videoPassthrough ? 'COPY' : 'TRANSCODE';

  if (videoPassthrough) {
    log('success', 'Mode vidéo: COPIE DIRECTE / PASSTHROUGH (H.264 détecté - remuxing instantané)');
  } else {
    if (burnInSubtitles) {
      log('warn', `Mode vidéo: RÉENCODAGE AVEC INCRUSTATION SOUS-TITRES (Burn-in actif)`);
    } else {
      log('warn', `Mode vidéo: RÉENCODAGE MATÉRIEL WEBCODECS GPU (Codec source ${videoStream.codec_name || videoStream.codec_id})`);
    }
  }

  if (audioStream) {
    if (audioPassthrough) {
      log('success', 'Mode audio: COPIE DIRECTE / PASSTHROUGH (AAC détecté)');
    } else {
      log('info', `Mode audio: TRANSCODAGE EN AAC 192kbps STÉRÉO (Codec source ${audioStream.codec_name || audioStream.codec_id})`);
    }
  }

  let bytesWritten = 0;
  const streamTarget = new MP4Muxer.StreamTarget({
    onData: (data: Uint8Array, _position: number) => {
      bytesWritten += data.byteLength;
      emitChunk(data);
    },
  });

  const targetWidth = videoStream.width || 1920;
  const targetHeight = videoStream.height || 1080;

  const muxerConfig: MP4Muxer.MuxerOptions<MP4Muxer.StreamTarget> = {
    target: streamTarget,
    video: {
      codec: 'avc',
      width: targetWidth,
      height: targetHeight,
    },
    fastStart: 'in-memory',
  };

  if (audioStream) {
    muxerConfig.audio = {
      codec: 'aac',
      numberOfChannels: 2,
      sampleRate: audioStream.sample_rate || 44100,
    };
  }

  const muxer = new MP4Muxer.Muxer(muxerConfig);

  let videoDecoder: VideoDecoder | null = null;
  let videoEncoder: VideoEncoder | null = null;
  let canvas: OffscreenCanvas | null = null;
  let ctx: OffscreenCanvasRenderingContext2D | null = null;
  let encodedFramesCount = 0;

  if (!videoPassthrough) {
    if (typeof VideoEncoder === 'undefined' || typeof VideoDecoder === 'undefined') {
      throw new Error(
        `Ce navigateur ne supporte pas WebCodecs (VideoEncoder/VideoDecoder) nécessaire pour réencoder ce format vidéo (${videoStream.codec_name || videoStream.codec_id}). Veuillez utiliser Chrome/Edge ou fournir un fichier source en H.264 sans burn-in.`
      );
    }

    // Determine H.264 encoder level based on resolution
    // Level 5.1 (0x33) supports up to 4K / 1080p60
    // Level 4.0 (0x28) supports 1080p
    const pixels = targetWidth * targetHeight;
    let avcCodecString = 'avc1.640033'; // High Profile Level 5.1
    if (pixels <= 921600) {
      avcCodecString = 'avc1.4d401f'; // Main Level 3.1 for 720p or lower
    } else if (pixels <= 2097152) {
      avcCodecString = 'avc1.4d4028'; // Main Level 4.0 for 1080p
    }

    videoEncoder = new VideoEncoder({
      output: (chunk, metadata) => {
        muxer.addVideoChunk(chunk, metadata);
        encodedFramesCount++;
      },
      error: (e) => log('error', `Erreur VideoEncoder: ${e.message}`),
    });

    // Detect hardware support, fallback to 'no-preference'
    let encoderHw: HardwareAcceleration = 'prefer-hardware';
    try {
      const hwCheck = await VideoEncoder.isConfigSupported({
        codec: avcCodecString,
        width: targetWidth,
        height: targetHeight,
        hardwareAcceleration: 'prefer-hardware',
      });
      if (!hwCheck.supported) {
        encoderHw = 'no-preference';
      }
    } catch {
      encoderHw = 'no-preference';
    }

    videoEncoder.configure({
      codec: avcCodecString,
      width: targetWidth,
      height: targetHeight,
      bitrate: 5_000_000,
      framerate: 30,
      hardwareAcceleration: encoderHw,
    });

    if (burnInSubtitles) {
      canvas = new OffscreenCanvas(targetWidth, targetHeight);
      ctx = canvas.getContext('2d', { willReadFrequently: false });
    }

    videoDecoder = new VideoDecoder({
      output: (frame) => {
        const keyFrame = encodedFramesCount % 60 === 0;

        if (burnInSubtitles && ctx && canvas) {
          // Draw decoded frame to OffscreenCanvas
          ctx.drawImage(frame, 0, 0, targetWidth, targetHeight);

          // Find active subtitle cue for current timestamp (in seconds)
          const currentTimeSec = frame.timestamp / 1000000;
          const activeCue = subtitleCues.find(
            (c) => currentTimeSec >= c.start && currentTimeSec <= c.end
          );

          if (activeCue) {
            renderSubtitleText(ctx, activeCue.text, targetWidth, targetHeight);
          }

          // Create new VideoFrame from canvas
          const compositeFrame = new VideoFrame(canvas, {
            timestamp: frame.timestamp,
            duration: frame.duration || 33333,
          });

          if (videoEncoder && videoEncoder.state === 'configured') {
            videoEncoder.encode(compositeFrame, { keyFrame });
          }
          compositeFrame.close();
        } else {
          if (videoEncoder && videoEncoder.state === 'configured') {
            videoEncoder.encode(frame, { keyFrame });
          }
        }
        frame.close();
      },
      error: (e) => log('error', `Erreur VideoDecoder: ${e.message}`),
    });

    const inputDecoderCodec = mapLibavCodecToWebCodecs(videoStream.codec_id, videoStream.codec_name);
    let decoderHw: HardwareAcceleration = 'prefer-hardware';
    try {
      const decCheck = await VideoDecoder.isConfigSupported({
        codec: inputDecoderCodec,
        hardwareAcceleration: 'prefer-hardware',
      });
      if (!decCheck.supported) {
        decoderHw = 'no-preference';
      }
    } catch {
      decoderHw = 'no-preference';
    }

    const decoderConfig: VideoDecoderConfig = {
      codec: inputDecoderCodec,
      hardwareAcceleration: decoderHw,
    };

    // Only provide description if AVC/H.264 extradata
    if (videoStream.extradata && videoStream.codec_id === 27) {
      decoderConfig.description = videoStream.extradata;
    }

    videoDecoder.configure(decoderConfig);
  }

  let audioEncoder: AudioEncoder | null = null;
  let audioCodecCtx: any = null;
  let audioPkt: any = null;
  let audioFrame: any = null;

  if (audioStream && !audioPassthrough) {
    if (typeof AudioEncoder === 'undefined') {
      log('warn', `AudioEncoder non supporté par ce navigateur. L'audio source (${audioStream.codec_name || audioStream.codec_id}) sera omis.`);
    } else {
      try {
        const decInit = await (libav as any).ff_init_decoder(
          audioStream.codec_id,
          audioStream.codecpar ? { codecpar: audioStream.codecpar } : undefined
        );
        audioCodecCtx = decInit[1];
        audioPkt = decInit[2];
        audioFrame = decInit[3];

        audioEncoder = new AudioEncoder({
          output: (chunk, metadata) => {
            muxer.addAudioChunk(chunk, metadata);
          },
          error: (e) => log('error', `Erreur AudioEncoder: ${e.message}`),
        });

        audioEncoder.configure({
          codec: 'mp4a.40.2',
          numberOfChannels: 2,
          sampleRate: audioStream.sample_rate || 44100,
          bitrate: 192000,
        });
      } catch (err: any) {
        log('warn', `Impossible d'initialiser le décodeur audio libav (${err?.message || err}), l'audio sera ignoré.`);
        audioCodecCtx = null;
        audioPkt = null;
        audioFrame = null;
      }
    }
  }

  const startTime = performance.now();
  let processedVideoFrames = 0;
  let lastTimestamp = 0;

  log('info', 'Traitement des trames au fil de l\'eau...');

  const pkt = await libav.av_packet_alloc();

  while (true) {
    const readRes = await libav.av_read_frame(fmt_ctx, pkt);
    if (readRes < 0) {
      break;
    }

    const streamIndex = await libav.AVPacket_stream_index(pkt);
    const pts = await libav.AVPacket_pts(pkt);
    const duration = await libav.AVPacket_duration(pkt);
    const flags = await libav.AVPacket_flags(pkt);
    const size = await libav.AVPacket_size(pkt);
    const dataPtr = await libav.AVPacket_data(pkt);
    const pktData = await libav.copyout_u8(dataPtr, size);

    if (streamIndex === videoStreamIndex) {
      processedVideoFrames++;
      const ptsUs = (pts * videoStream.time_base_num * 1000000) / videoStream.time_base_den;
      lastTimestamp = ptsUs / 1000000;

      const isKeyFrame = Boolean(flags & 1);
      const frameDuration = (duration * videoStream.time_base_num * 1000000) / videoStream.time_base_den || 33333;

      if (videoPassthrough) {
        const meta = (processedVideoFrames === 1 && videoStream.extradata) ? {
          decoderConfig: {
            codec: 'avc1.4d401f',
            description: videoStream.extradata,
          },
        } : undefined;

        muxer.addVideoChunkRaw(
          pktData,
          isKeyFrame ? 'key' : 'delta',
          ptsUs,
          frameDuration,
          meta
        );
      } else if (typeof VideoDecoder !== 'undefined' && videoDecoder && videoDecoder.state === 'configured') {
        try {
          const chunk = new (self as any).EncodedVideoChunk({
            type: isKeyFrame ? 'key' : 'delta',
            timestamp: ptsUs,
            duration: frameDuration,
            data: pktData,
          });
          videoDecoder.decode(chunk);
        } catch {
          // ignore decode packet error
        }
      }

      if (processedVideoFrames % 15 === 0) {
        const elapsedSec = (performance.now() - startTime) / 1000;
        const fps = Math.round(processedVideoFrames / elapsedSec);
        const speed = elapsedSec > 0 ? lastTimestamp / elapsedSec : 0;
        const percent = durationSec > 0 ? Math.min(99, Math.round((lastTimestamp / durationSec) * 100)) : 0;
        const bitrateMBs = elapsedSec > 0 ? bytesWritten / (1024 * 1024 * elapsedSec) : 0;
        const etaSeconds = speed > 0 && durationSec > lastTimestamp ? Math.round((durationSec - lastTimestamp) / speed) : 0;

        postMessage({
          type: 'PROGRESS',
          percent,
          fps,
          speed: parseFloat(speed.toFixed(2)),
          bitrateMBs: parseFloat(bitrateMBs.toFixed(2)),
          etaSeconds,
          mode,
        } as WorkerProgressMessage);
      }
    } else if (audioStream && streamIndex === audioStream.index) {
      const ptsUs = (pts * audioStream.time_base_num * 1000000) / audioStream.time_base_den;
      const isKeyFrame = Boolean(flags & 1);
      const audioDuration = (duration * audioStream.time_base_num * 1000000) / audioStream.time_base_den || 23219;

      if (audioPassthrough) {
        muxer.addAudioChunkRaw(
          pktData,
          isKeyFrame ? 'key' : 'delta',
          ptsUs,
          audioDuration
        );
      } else if (audioEncoder && audioCodecCtx && audioFrame) {
        const sendRes = await (libav as any).avcodec_send_packet(audioCodecCtx, pkt);
        if (sendRes >= 0) {
          while (true) {
            const receiveRes = await (libav as any).avcodec_receive_frame(audioCodecCtx, audioFrame);
            if (receiveRes < 0) break;

            const copiedFrame = await (libav as any).ff_copyout_frame(audioFrame);
            if (copiedFrame && copiedFrame.data) {
              const sampleRate = audioStream.sample_rate || 44100;
              const channels = copiedFrame.channels || audioStream.channels || 2;
              const nbSamples = copiedFrame.nb_samples || (copiedFrame.data.length / channels);

              let pcmFloat32: Float32Array;
              if (copiedFrame.data instanceof Float32Array) {
                pcmFloat32 = copiedFrame.data;
              } else if (Array.isArray(copiedFrame.data) && copiedFrame.data[0] instanceof Float32Array) {
                pcmFloat32 = new Float32Array(nbSamples * channels);
                for (let ch = 0; ch < channels; ch++) {
                  const chData = copiedFrame.data[ch];
                  for (let s = 0; s < nbSamples; s++) {
                    pcmFloat32[s * channels + ch] = chData[s] || 0;
                  }
                }
              } else {
                pcmFloat32 = new Float32Array(copiedFrame.data);
              }

              const framePtsUs = copiedFrame.pts != null && audioStream.time_base_den
                ? (copiedFrame.pts * audioStream.time_base_num * 1000000) / audioStream.time_base_den
                : ptsUs;

              try {
                const audioData = new AudioData({
                  format: 'f32',
                  sampleRate,
                  numberOfChannels: channels,
                  numberOfFrames: nbSamples,
                  timestamp: Math.round(framePtsUs),
                  data: pcmFloat32.buffer as ArrayBuffer,
                });
                audioEncoder.encode(audioData);
                audioData.close();
              } catch (audioEncErr: any) {
                log('warn', `Avertissement encodage audio: ${audioEncErr.message}`);
              }
            }
          }
        }
      }
    } else if (subtitleStream && streamIndex === subtitleStream.index) {
      // Decode or parse embedded text subtitle packet
      try {
        const textDecoder = new TextDecoder('utf-8');
        const subText = textDecoder.decode(pktData);
        const ptsSec = (pts * subtitleStream.time_base_num) / subtitleStream.time_base_den;
        const durSec = (duration * subtitleStream.time_base_num) / subtitleStream.time_base_den || 3.0;

        const cleanText = subText
          .replace(/<[^>]*>/g, '')
          .replace(/\{[^}]*\}/g, '')
          .trim();

        if (cleanText) {
          subtitleCues.push({
            start: ptsSec,
            end: ptsSec + durSec,
            text: cleanText,
          });
        }
      } catch {
        // ignore subtitle parse error
      }
    }
  }

  await libav.av_packet_free_js(pkt);

  if (audioFrame) {
    await libav.av_frame_free(audioFrame);
  }
  if (audioCodecCtx) {
    await libav.avcodec_free_context_js(audioCodecCtx);
  }

  if (videoDecoder) {
    await videoDecoder.flush();
  }
  if (videoEncoder) {
    await videoEncoder.flush();
  }
  if (audioEncoder) {
    await audioEncoder.flush();
  }

  muxer.finalize();

  if (audioCodecCtx && audioPkt && audioFrame) {
    try {
      await (libav as any).ff_free_decoder(audioCodecCtx, audioPkt, audioFrame);
    } catch {
      // ignore decoder cleanup error
    }
  }

  await libav.avformat_close_input_js(fmt_ctx);
  await libav.unlink(filename);

  log('success', 'Conversion terminée avec succès !');
}

function renderSubtitleText(
  ctx: OffscreenCanvasRenderingContext2D,
  text: string,
  width: number,
  height: number
) {
  const fontSize = Math.max(18, Math.round(height * 0.045));
  ctx.save();
  ctx.font = `bold ${fontSize}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';

  const lines = text.split('\n');
  const lineHeight = fontSize * 1.25;
  const bottomMargin = Math.round(height * 0.07);
  const startY = height - bottomMargin - (lines.length - 1) * lineHeight;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const y = startY + i * lineHeight;
    const x = width / 2;

    // Outer shadow / outline for readability
    ctx.lineWidth = Math.max(3, Math.round(fontSize * 0.15));
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.9)';
    ctx.strokeText(line, x, y);

    // Text fill (crisp white)
    ctx.fillStyle = '#ffffff';
    ctx.fillText(line, x, y);
  }
  ctx.restore();
}
