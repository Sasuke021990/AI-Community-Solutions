import { BrowserWindow } from 'electron';
import { PDFDocument } from 'pdf-lib';
import { writeFile, mkdir } from 'fs/promises';
import { dirname } from 'path';
import type { RunReportHtml } from '@acs/core';

const MARGINS = { top: 0.5, bottom: 0.7, left: 0.6, right: 0.6 }; // inches; bottom leaves room for the footer

async function printHtml(html: string, opts: { header?: string; footer?: string }): Promise<Buffer> {
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, javascript: false } });
  try {
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    return await win.webContents.printToPDF({
      pageSize: 'A4',
      printBackground: true,
      margins: MARGINS,
      displayHeaderFooter: !!(opts.header || opts.footer),
      headerTemplate: opts.header ?? '<span></span>',
      footerTemplate: opts.footer ?? '<span></span>'
    });
  } finally {
    win.destroy();
  }
}

/** Merges PDF buffers (in order) into one document. Pure - no Electron dependency, unit-testable. */
export async function mergePdfBuffers(buffers: Buffer[]): Promise<Buffer> {
  const merged = await PDFDocument.create();
  for (const buf of buffers) {
    const doc = await PDFDocument.load(buf);
    const pages = await merged.copyPages(doc, doc.getPageIndices());
    for (const page of pages) merged.addPage(page);
  }
  return Buffer.from(await merged.save());
}

export async function writeRunPdf(report: RunReportHtml, outPath: string, problem: string, dateStr: string): Promise<void> {
  await mkdir(dirname(outPath), { recursive: true });

  const coverBytes = await printHtml(report.coverHtml, {});   // no header/footer at all

  const shortProblem = problem.length > 70 ? problem.substring(0, 67) + '...' : problem;

  const headerTemplate =
    '<div style="font-size:8px;width:100%;margin:0 12mm;padding:6px 0 4px;display:flex;' +
    'justify-content:space-between;color:#5b6b7f;border-bottom:1px solid #1e3a5f;">' +
    `<span>${escapeHtml(shortProblem)}</span><span>${escapeHtml(dateStr)}</span></div>`;
  const footerTemplate =
    '<div style="font-size:8px;width:100%;padding:0 12mm;display:flex;justify-content:space-between;color:#5b6b7f;">' +
    '<span>AI Community Solutions</span>' +
    '<span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span></div>';
  const bodyBytes = await printHtml(report.bodyHtml, { header: headerTemplate, footer: footerTemplate });

  const merged = await mergePdfBuffers([coverBytes as unknown as Buffer, bodyBytes as unknown as Buffer]);
  await writeFile(outPath, merged);
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
