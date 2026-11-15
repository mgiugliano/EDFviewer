import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  parseHfoEventFile,
  parseHfoSummaryFile,
  computeHfoSummaryFromAnnotations,
  isHfoSummaryText,
} from './hfoParser.js';

describe('HFOapp Report Parser', () => {
  const dataDir = path.resolve(__dirname, '../../../../HFOapp_conversion/data');

  it('correctly identifies summary files', () => {
    const summaryPath = path.join(dataDir, '20201007a_HFO_CUT_summary.txt');
    if (fs.existsSync(summaryPath)) {
      const text = fs.readFileSync(summaryPath, 'utf-8');
      expect(isHfoSummaryText(text)).toBe(true);
    }
  });

  it('parses real 20201007a_HFO_CUT_summary.txt accurately', () => {
    const summaryPath = path.join(dataDir, '20201007a_HFO_CUT_summary.txt');
    if (!fs.existsSync(summaryPath)) return;

    const text = fs.readFileSync(summaryPath, 'utf-8');
    const report = parseHfoSummaryFile(text, '20201007a_HFO_CUT_summary.txt');

    expect(report.channels.length).toBe(6);
    const fcr = report.channels.find((c) => c.channel === 'FCR');
    expect(fcr).toBeDefined();
    expect(fcr?.rippleCount).toBe(42);
    expect(fcr?.fastrippleCount).toBe(1);
    expect(fcr?.rippleDurSec).toBeCloseTo(0.370, 3);
    expect(fcr?.fastrippleDurSec).toBeCloseTo(0.004, 3);

    const dgdl = report.channels.find((c) => c.channel === 'DGD-L');
    expect(dgdl?.rippleCount).toBe(85);
  });

  it('parses real 20201007a_HFO_CUT.txt events accurately with fs = 4000', () => {
    const eventPath = path.join(dataDir, '20201007a_HFO_CUT.txt');
    if (!fs.existsSync(eventPath)) return;

    const text = fs.readFileSync(eventPath, 'utf-8');
    const { annotations, set } = parseHfoEventFile(text, 4000, {
      setName: '20201007a_HFO_CUT.txt',
    });

    expect(annotations.length).toBe(280);
    expect(set.name).toBe('20201007a_HFO_CUT.txt');
    expect(set.count).toBe(280);
    expect(set.source).toBe('hfoapp');

    // First event: FCR at 111358..111374
    // 111358 / 4000 = 27.8395
    // (111374 - 111358) / 4000 = 0.004
    const first = annotations[0];
    expect(first.channel).toBe('FCR');
    expect(first.onset).toBeCloseTo(27.8395, 4);
    expect(first.duration).toBeCloseTo(0.004, 4);
    expect(first.label).toBe('ripple; fastripple');
    expect(first.note).toContain('1000.0 Hz');
    expect(first.metadata?.avgFreqHz).toBe(1000);
    expect(first.metadata?.peakZscore).toBe(5.63);
    expect(first.metadata?.numCycles).toBe(4.25);
  });

  it('computes summary matching the summary file', () => {
    const eventPath = path.join(dataDir, '20201007a_HFO_CUT.txt');
    if (!fs.existsSync(eventPath)) return;

    const text = fs.readFileSync(eventPath, 'utf-8');
    const { annotations } = parseHfoEventFile(text, 4000);
    const computed = computeHfoSummaryFromAnnotations(annotations);

    const fcr = computed.channels.find((c) => c.channel === 'FCR');
    expect(fcr).toBeDefined();
    expect(fcr?.fastrippleCount).toBe(1);
    expect(fcr?.rippleCount).toBe(42);
    expect(fcr?.fastrippleDurSec).toBeCloseTo(0.004, 3);
  });

  it('parses real 20220620a_HFO_CUT.txt and 20230606a_NEC_CUT.txt', () => {
    const f2022 = path.join(dataDir, '20220620a_HFO_CUT.txt');
    if (fs.existsSync(f2022)) {
      const { annotations } = parseHfoEventFile(fs.readFileSync(f2022, 'utf-8'), 4000);
      expect(annotations.length).toBe(87);
    }

    const f2023 = path.join(dataDir, '20230606a_NEC_CUT.txt');
    if (fs.existsSync(f2023)) {
      const { annotations } = parseHfoEventFile(fs.readFileSync(f2023, 'utf-8'), 4000);
      expect(annotations.length).toBe(181);
    }
  });
});
