export interface SubtitleCue {
  start: number; // in seconds
  end: number;   // in seconds
  text: string;
}

export function parseSRT(content: string): SubtitleCue[] {
  const cues: SubtitleCue[] = [];
  const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
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
    // Remove HTML formatting tags if present like <b>, <i>, <font>
    const cleanText = textLines
      .join('\n')
      .replace(/<[^>]*>/g, '')
      .replace(/\{[^}]*\}/g, '') // ASS tags like {\pos(x,y)}
      .trim();

    if (cleanText && end > start) {
      cues.push({ start, end, text: cleanText });
    }
  }

  return cues;
}

export function parseWebVTT(content: string): SubtitleCue[] {
  // WebVTT format is very similar to SRT
  return parseSRT(content.replace(/^WEBVTT[^\n]*\n+/i, ''));
}
