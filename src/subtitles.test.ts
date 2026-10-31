import { describe, it, expect } from 'vitest';
import { parseSRT, parseWebVTT } from './subtitles';

describe('Subtitle parsers', () => {
  it('parses SRT content correctly', () => {
    const srt = `1
00:00:01,500 --> 00:00:04,000
Bonjour le monde !

2
00:00:05,000 --> 00:00:08,250
Deuxième <b>ligne</b>
avec un saut de ligne.
`;
    const cues = parseSRT(srt);
    expect(cues).toHaveLength(2);
    expect(cues[0].start).toBe(1.5);
    expect(cues[0].end).toBe(4.0);
    expect(cues[0].text).toBe('Bonjour le monde !');

    expect(cues[1].start).toBe(5.0);
    expect(cues[1].end).toBe(8.25);
    expect(cues[1].text).toBe('Deuxième ligne\navec un saut de ligne.');
  });

  it('parses WebVTT content correctly', () => {
    const vtt = `WEBVTT

1
00:00:02.000 --> 00:00:05.000
Test WebVTT
`;
    const cues = parseWebVTT(vtt);
    expect(cues).toHaveLength(1);
    expect(cues[0].start).toBe(2);
    expect(cues[0].end).toBe(5);
    expect(cues[0].text).toBe('Test WebVTT');
  });
});
