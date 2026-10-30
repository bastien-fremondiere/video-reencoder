/**
  * Interface for continuous chunk writing (File System Access API or SW stream fallback)
  */
export interface StreamWritable {
  write(chunk: Uint8Array): Promise<void>;
  close(): Promise<void>;
}

export async function createWritableStream(filename: string): Promise<StreamWritable> {
  // Try File System Access API
  if ('showSaveFilePicker' in window) {
    try {
      const handle = await (window as any).showSaveFilePicker({
        suggestedName: filename,
        types: [
          {
            description: 'MP4 Video',
            accept: { 'video/mp4': ['.mp4'] },
          },
        ],
      });
      const writableStream: FileSystemWritableFileStream = await handle.createWritable();
      return {
        write: async (chunk: Uint8Array) => {
          // Pass ArrayBuffer directly or Uint8Array cast as ArrayBufferView
          await writableStream.write(chunk as unknown as BufferSource);
        },
        close: async () => {
          await writableStream.close();
        },
      };
    } catch (err: any) {
      if (err.name === 'AbortError') {
        throw new Error('L\'utilisateur a annulé la sélection de fichier.');
      }
      console.warn('showSaveFilePicker a échoué, passage au fallback ServiceWorker stream:', err);
    }
  }

  // Fallback: Service Worker streaming download
  if (!('serviceWorker' in navigator)) {
    throw new Error('Votre navigateur ne prend en charge ni la File System Access API ni les Service Workers.');
  }

  const registration = await navigator.serviceWorker.register('./sw-stream.js');
  await navigator.serviceWorker.ready;

  const channel = new MessageChannel();
  const streamUrl = new URL(`./sw-stream-download/${Date.now()}/${encodeURIComponent(filename)}`, window.location.href).href;

  const readyPromise = new Promise<void>((resolve) => {
    channel.port1.onmessage = (e) => {
      if (e.data && e.data.type === 'READY') {
        resolve();
      }
    };
  });

  const swTarget = registration.active || navigator.serviceWorker.controller;
  if (!swTarget) {
    throw new Error('Service Worker introuvable.');
  }

  swTarget.postMessage(
    {
      type: 'PORT_INITIALIZE',
      url: streamUrl,
      filename,
    },
    [channel.port2]
  );

  await readyPromise;

  // Trigger browser download via iframe
  const iframe = document.createElement('iframe');
  iframe.hidden = true;
  iframe.src = streamUrl;
  document.body.appendChild(iframe);

  return {
    write: async (chunk: Uint8Array) => {
      // Copy array to standard ArrayBuffer if necessary
      const buffer = chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength);
      channel.port1.postMessage(buffer, [buffer]);
    },
    close: async () => {
      channel.port1.postMessage('end');
      setTimeout(() => iframe.remove(), 10000);
    },
  };
}
