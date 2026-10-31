/**
 * Interface for continuous chunk writing
 */
export interface StreamWritable {
  isDirectDisk: boolean;
  write(chunk: Uint8Array): Promise<void>;
  close(): Promise<void>;
  getBlobUrl?(): Promise<string> | string;
}

export async function createWritableStream(filename: string): Promise<StreamWritable> {
  const isMocked = Boolean(
    (window as any).__MOCK_SAVE_FILE_PICKER__ ||
    (typeof navigator !== 'undefined' && (navigator as any).__playwright_mock)
  );

  if (isMocked) {
    const memoryChunks: Uint8Array[] = [];
    return {
      isDirectDisk: false,
      write: async (chunk: Uint8Array) => {
        memoryChunks.push(chunk);
      },
      close: async () => {},
      getBlobUrl: () => {
        const blob = new Blob(memoryChunks as BlobPart[], { type: 'video/mp4' });
        return URL.createObjectURL(blob);
      },
    };
  }

  // File System Access API (Chrome, Edge, Opera) - True Zero-OOM direct disk writing
  if ('showSaveFilePicker' in window) {
    try {
      const handle = await (window as any).showSaveFilePicker({
        suggestedName: filename,
        types: [
          {
            description: 'Fichier Vidéo MP4',
            accept: { 'video/mp4': ['.mp4'] },
          },
        ],
      });
      const writableStream: FileSystemWritableFileStream = await handle.createWritable();
      return {
        isDirectDisk: true,
        write: async (chunk: Uint8Array) => {
          await writableStream.write(chunk as unknown as BufferSource);
        },
        close: async () => {
          await writableStream.close();
        },
        getBlobUrl: async () => {
          const file = await handle.getFile();
          return URL.createObjectURL(file);
        },
      };
    } catch (err: any) {
      if (err.name === 'AbortError') {
        throw new Error('L\'utilisateur a annulé la sélection de fichier.');
      }
      console.warn('showSaveFilePicker indisponible ou annulé, passage au fallback:', err);
    }
  }

  // Fallback for browsers without File System Access API
  const memoryChunks: Uint8Array[] = [];
  return {
    isDirectDisk: false,
    write: async (chunk: Uint8Array) => {
      memoryChunks.push(chunk);
    },
    close: async () => {},
    getBlobUrl: () => {
      const blob = new Blob(memoryChunks as BlobPart[], { type: 'video/mp4' });
      return URL.createObjectURL(blob);
    },
  };
}
