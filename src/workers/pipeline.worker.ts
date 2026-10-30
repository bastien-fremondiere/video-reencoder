import LibAV from 'libav.js';
import * as MP4Muxer from 'mp4-muxer';

export interface WorkerStartMessage {
  type: 'START';
  file: File;
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

self.onmessage = async (e: MessageEvent<WorkerStartMessage>) => {
  if (e.data.type !== 'START') return;

  const file = e.data.file;
  log('info', `Début du traitement de "${file.name}" (${(file.size / (1024 * 1024)).toFixed(2)} Mo)`);

  try {
    await processVideoFile(file);
    postMessage({ type: 'DONE' } as WorkerDoneMessage);
  } catch (err: any) {
    const errorMsg = err && err.stack ? `${err.name || 'Error'}: ${err.message || err}\n${err.stack}` : String(err?.message || err);
    log('error', `Erreur de traitement: ${errorMsg}`);
    postMessage({ type: 'ERROR', error: errorMsg } as WorkerErrorMessage);
  }
};

function mapLibavCodecToWebCodecs(codecId: number | string, codecName?: string): string {
  const name = (codecName || '').toLowerCase();

  if (name.includes('hevc') || name.includes('h265') || codecId === 173 || codecId === 'hevc') {
    return 'hev1.1.6.L93.B0';
  }
  if (name.includes('vp9') || codecId === 167 || codecId === 'vp9') {
    return 'vp09.00.10.08';
  }
  if (name.includes('vp8') || codecId === 139 || codecId === 'vp8') {
    return 'vp8';
  }
  if (name.includes('av1') || codecId === 225 || codecId === 'av1') {
    return 'av01.0.04M.08';
  }
  return 'avc1.4d401f';
}

async function processVideoFile(file: File) {
  log('info', 'Chargement du module WASM libav.js...');
  const libav = await LibAV.LibAV({
    variant: 'webcodecs-avf',
  });

  const filename = 'input_file';
  await libav.mkworkerfsfile(filename, file);

  log('info', 'Ouverture du fichier et analyse des flux...');
  const [fmt_ctx, streams] = await libav.ff_init_demuxer_file(filename);

  let videoStreamIndex = -1;
  let audioStreamIndex = -1;
  let videoStream: any = null;
  let audioStream: any = null;

  for (let i = 0; i < streams.length; i++) {
    const s: any = streams[i];
    if (s.codec_type === libav.AVMEDIA_TYPE_VIDEO && videoStreamIndex === -1) {
      videoStreamIndex = i;
      videoStream = s;
    } else if (s.codec_type === libav.AVMEDIA_TYPE_AUDIO && audioStreamIndex === -1) {
      audioStreamIndex = i;
      audioStream = s;
    }
  }

  if (videoStreamIndex === -1) {
    throw new Error('Aucun flux vidéo trouvé dans le fichier d\'entrée.');
  }

  const durationSec = videoStream.duration_time || (file.size / 1000000) * 0.5;
  log('info', `Flux vidéo détecté [Index ${videoStreamIndex}]: Codec ID ${videoStream.codec_id}, ${videoStream.width}x${videoStream.height}`);
  if (audioStream) {
    log('info', `Flux audio détecté [Index ${audioStreamIndex}]: Codec ID ${audioStream.codec_id}, ${audioStream.channels} canaux, ${audioStream.sample_rate} Hz`);
  }

  const isH264 = videoStream.codec_id === 27 || videoStream.codec_id === 'h264' || videoStream.codec_name === 'h264';
  const isAAC = audioStream && (audioStream.codec_id === 86018 || audioStream.codec_id === 'aac' || audioStream.codec_name === 'aac');

  const videoPassthrough = isH264;
  const audioPassthrough = audioStream ? isAAC : false;

  const mode: 'COPY' | 'TRANSCODE' = videoPassthrough ? 'COPY' : 'TRANSCODE';

  if (videoPassthrough) {
    log('success', 'Mode vidéo: COPIE DIRECTE / PASSTHROUGH (H.264 détecté - remuxing instantané)');
  } else {
    log('warn', `Mode vidéo: RÉENCODAGE MATÉRIEL WEBCODECS GPU (Codec source ${videoStream.codec_name || videoStream.codec_id})`);
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
    onData: (data: Uint8Array) => {
      bytesWritten += data.byteLength;
      emitChunk(data);
    },
  });

  const muxerConfig: MP4Muxer.MuxerOptions<MP4Muxer.StreamTarget> = {
    target: streamTarget,
    video: {
      codec: 'avc',
      width: videoStream.width || 1920,
      height: videoStream.height || 1080,
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
  let encodedFramesCount = 0;

  if (!videoPassthrough) {
    videoEncoder = new VideoEncoder({
      output: (chunk, metadata) => {
        muxer.addVideoChunk(chunk, metadata);
        encodedFramesCount++;
      },
      error: (e) => log('error', `Erreur VideoEncoder: ${e.message}`),
    });

    videoEncoder.configure({
      codec: 'avc1.4d401f',
      width: videoStream.width || 1920,
      height: videoStream.height || 1080,
      bitrate: 5_000_000,
      framerate: 30,
      hardwareAcceleration: 'prefer-hardware',
    });

    videoDecoder = new VideoDecoder({
      output: (frame) => {
        const keyFrame = encodedFramesCount % 60 === 0;
        if (videoEncoder && videoEncoder.state === 'configured') {
          videoEncoder.encode(frame, { keyFrame });
        }
        frame.close();
      },
      error: (e) => log('error', `Erreur VideoDecoder: ${e.message}`),
    });

    const inputDecoderCodec = mapLibavCodecToWebCodecs(videoStream.codec_id, videoStream.codec_name);
    const decoderConfig: VideoDecoderConfig = {
      codec: inputDecoderCodec,
      hardwareAcceleration: 'prefer-hardware',
    };
    if (videoStream.extradata) {
      decoderConfig.description = videoStream.extradata;
    }

    videoDecoder.configure(decoderConfig);
  }

  let audioEncoder: AudioEncoder | null = null;
  let audioCodecCtx: any = null;
  let audioFrame: any = null;

  if (audioStream && !audioPassthrough) {
    audioCodecCtx = await libav.avcodec_alloc_context3(audioStream.codec_id);
    await libav.avcodec_parameters_to_context(audioCodecCtx, audioStream);
    const openRes = await libav.avcodec_open2_js(audioCodecCtx, 0, 0);
    if (openRes < 0) {
      log('warn', `Impossible d'ouvrir le décodeur audio libav (${openRes}), l'audio sera ignoré.`);
      audioCodecCtx = null;
    } else {
      audioFrame = await libav.av_frame_alloc();
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
    }
  }

  const startTime = performance.now();
  let processedVideoFrames = 0;
  let lastTimestamp = 0;

  log('info', 'Traitement des trames...');

  const pkt = await libav.av_packet_alloc();

  while (true) {
    const [readRes, streamPkts] = await libav.ff_read_frame_multi(fmt_ctx, pkt);
    if (readRes === libav.AVERROR_EOF || !streamPkts) {
      break;
    }

    const videoPkts = streamPkts[videoStreamIndex] || [];
    for (const p of videoPkts) {
      processedVideoFrames++;
      const pts = p.pts ?? 0;
      const flags = p.flags ?? 0;
      const duration = p.duration ?? 0;

      const ptsUs = (pts * videoStream.time_base_num * 1000000) / videoStream.time_base_den;
      lastTimestamp = ptsUs / 1000000;

      if (videoPassthrough) {
        const isKeyFrame = Boolean(flags & 1);
        const chunk = new EncodedVideoChunk({
          type: isKeyFrame ? 'key' : 'delta',
          timestamp: ptsUs,
          duration: (duration * videoStream.time_base_num * 1000000) / videoStream.time_base_den || 33333,
          data: p.data,
        });
        muxer.addVideoChunk(chunk);
      } else if (videoDecoder && videoDecoder.state === 'configured') {
        const isKeyFrame = Boolean(flags & 1);
        const chunk = new EncodedVideoChunk({
          type: isKeyFrame ? 'key' : 'delta',
          timestamp: ptsUs,
          duration: (duration * videoStream.time_base_num * 1000000) / videoStream.time_base_den || 33333,
          data: p.data,
        });
        try {
          videoDecoder.decode(chunk);
        } catch {
          // ignore packet error
        }
      }
    }

    if (audioStream) {
      const audioPkts = streamPkts[audioStreamIndex] || [];
      for (const p of audioPkts) {
        const pts = p.pts ?? 0;
        const flags = p.flags ?? 0;
        const duration = p.duration ?? 0;

        const ptsUs = (pts * audioStream.time_base_num * 1000000) / audioStream.time_base_den;

        if (audioPassthrough) {
          const isKeyFrame = Boolean(flags & 1);
          const chunk = new EncodedAudioChunk({
            type: isKeyFrame ? 'key' : 'delta',
            timestamp: ptsUs,
            duration: (duration * audioStream.time_base_num * 1000000) / audioStream.time_base_den || 23219,
            data: p.data,
          });
          muxer.addAudioChunk(chunk);
        } else if (audioEncoder && audioCodecCtx && audioFrame) {
          const sendRes = await (libav as any).avcodec_send_packet(audioCodecCtx, (p as any).ptr || p);
          if (sendRes >= 0) {
            while (true) {
              const receiveRes = await (libav as any).avcodec_receive_frame(audioCodecCtx, audioFrame);
              if (receiveRes < 0) break;

              const copiedFrame = await (libav as any).ff_copyout_frame(audioFrame);
              if (copiedFrame && copiedFrame.data) {
                const sampleRate = audioStream.sample_rate || 44100;
                const channels = copiedFrame.channels || audioStream.channels || 2;
                const nbSamples = copiedFrame.nb_samples || (copiedFrame.data.length / channels);

                // Convert float32 PCM samples into WebCodecs AudioData
                let pcmFloat32: Float32Array;
                if (copiedFrame.data instanceof Float32Array) {
                  pcmFloat32 = copiedFrame.data;
                } else if (Array.isArray(copiedFrame.data) && copiedFrame.data[0] instanceof Float32Array) {
                  // Planar float32
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
      }
    }

    if (processedVideoFrames > 0 && processedVideoFrames % 15 === 0) {
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
  }

  await libav.av_packet_free(pkt);

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

  await libav.avformat_close_input_js(fmt_ctx);
  await libav.unlinkworkerfsfile(filename);

  log('success', 'Conversion terminée avec succès !');
}
