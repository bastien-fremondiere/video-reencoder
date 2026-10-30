/**
 * Interface for continuous chunk writing
 */
export interface StreamWritable {
  write(chunk: Uint8Array): Promise<void>;
  close(): Promise<void>;
  getBlobUrl?(): string;
}

export async function createWritableStream(filename: string): Promise<StreamWritable> {
  const isMocked = Boolean(
    (window as any).__MOCK_SAVE_FILE_PICKER__ ||
    (typeof navigator !== 'undefined' && navigator.webdriver)
  );

  if (isMocked) {
    const memoryChunks: Uint8Array[] = [];
    return {
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

  // Try File System Access API (Chrome, Edge, Opera)
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
        write: async (chunk: Uint8Array) => {
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
      console.warn('showSaveFilePicker indisponible ou annulé, utilisation du mode de téléchargement direct en mémoire:', err);
    }
  }

  // Fallback for browsers without File System Access API (Firefox, Safari, Mobile)
  const memoryChunks: Uint8Array[] = [];
  return {
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
