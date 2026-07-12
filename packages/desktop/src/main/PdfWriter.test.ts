import { describe, it, expect } from 'vitest';
import { mergePdfBuffers } from './PdfWriter.js';
import { PDFDocument } from 'pdf-lib';

describe('mergePdfBuffers', () => {
  it('merges multiple PDF buffers and preserves page order', async () => {
    const doc1 = await PDFDocument.create();
    doc1.addPage([200, 200]);
    const doc2 = await PDFDocument.create();
    doc2.addPage([300, 300]);
    doc2.addPage([400, 400]);

    const buf1 = Buffer.from(await doc1.save());
    const buf2 = Buffer.from(await doc2.save());

    const mergedBuf = await mergePdfBuffers([buf1, buf2]);
    const mergedDoc = await PDFDocument.load(mergedBuf);

    expect(mergedDoc.getPageCount()).toBe(3);
    expect(mergedDoc.getPage(0).getSize().width).toBe(200);
    expect(mergedDoc.getPage(1).getSize().width).toBe(300);
    expect(mergedDoc.getPage(2).getSize().width).toBe(400);
  });
});
