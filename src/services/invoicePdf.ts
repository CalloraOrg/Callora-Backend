export interface InvoicePdfData {
  invoiceNumber: string;
  status: string;
  createdAt: Date;
  periodStart: Date | null;
  periodEnd: Date | null;
  totalAmountUsdc: string;
  currency: string;
  description: string | null;
  lineItems: InvoicePdfLineItem[];
}

export interface InvoicePdfLineItem {
  description: string;
  amountUsdc: string;
  quantity: number;
  unitPriceUsdc: string;
  itemType: string;
}

const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const MARGIN = 50;

function escapePdfString(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r');
}

function formatDate(d: Date): string {
  return d.toISOString().split('T')[0];
}

function formatCurrency(amount: string): string {
  const num = parseFloat(amount);
  return Number.isFinite(num) ? num.toFixed(2) : '0.00';
}

function truncateText(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + '...';
}

export function generateInvoicePdf(data: InvoicePdfData): Buffer {
  const lines: string[] = [];
  let y = PAGE_HEIGHT - MARGIN;

  function w(text: string): void {
    lines.push(text);
  }

  function text(font: string, size: number, x: number, yPos: number, txt: string): void {
    w(`BT ${font} ${size} Tf ${x} ${yPos} Td (${escapePdfString(txt)}) Tj ET`);
  }

  function rightText(font: string, size: number, rightX: number, yPos: number, txt: string): void {
    const tw = txt.length * size * 0.48;
    text(font, size, rightX - tw, yPos, txt);
  }

  function line(x1: number, y1: number, x2: number, y2: number): void {
    w(`${x1} ${y1} m ${x2} ${y2} l S`);
  }

  function strokeColor(r: number, g: number, b: number): void {
    w(`${r} ${g} ${b} RG`);
  }

  function fillColor(r: number, g: number, b: number): void {
    w(`${r} ${g} ${b} rg`);
  }

  function fillRect(x: number, yPos: number, wd: number, ht: number): void {
    w(`${x} ${yPos} ${wd} ${ht} re f`);
  }

  w('q');
  w('1 w');
  strokeColor(0, 0, 0);
  fillColor(0, 0, 0);

  // Title
  text('/F2', 24, MARGIN, y, 'INVOICE');
  y -= 6;
  strokeColor(0.2, 0.2, 0.2);
  w('2 w');
  line(MARGIN, y - 2, PAGE_WIDTH - MARGIN, y - 2);
  w('1 w');
  strokeColor(0, 0, 0);
  y -= 24;

  // Invoice metadata
  text('/F1', 10, MARGIN, y, `Invoice #: ${escapePdfString(data.invoiceNumber)}`);
  y -= 16;
  text('/F1', 10, MARGIN, y, `Date: ${formatDate(data.createdAt)}`);
  y -= 16;
  text('/F1', 10, MARGIN, y, `Status: ${escapePdfString(data.status.toUpperCase())}`);

  if (data.periodStart && data.periodEnd) {
    y -= 16;
    text('/F1', 10, MARGIN, y, `Period: ${formatDate(data.periodStart)} - ${formatDate(data.periodEnd)}`);
  }

  if (data.description) {
    y -= 16;
    text('/F1', 10, MARGIN, y, `Description: ${escapePdfString(data.description)}`);
  }

  y -= 32;

  const tableLeft = MARGIN;
  const tableRight = PAGE_WIDTH - MARGIN;
  const tableWidth = tableRight - tableLeft;
  const colDesc = tableLeft + 5;
  const colQty = tableLeft + 280;
  const colPrice = tableLeft + 370;

  // Table header
  strokeColor(0.4, 0.4, 0.4);
  w('0.5 w');
  fillColor(0.9, 0.9, 0.9);
  fillRect(tableLeft, y - 4, tableWidth, 20);
  fillColor(0, 0, 0);

  text('/F2', 10, colDesc, y, 'Description');
  text('/F2', 10, colQty, y, 'Qty');
  text('/F2', 10, colPrice, y, 'Unit Price');
  rightText('/F2', 10, tableRight - 5, y, 'Amount');

  y -= 22;

  for (const item of data.lineItems) {
    line(tableLeft, y - 2, tableRight, y - 2);
    text('/F1', 10, colDesc, y, truncateText(escapePdfString(item.description), 38));
    text('/F1', 10, colQty, y, String(item.quantity));
    text('/F1', 10, colPrice, y, formatCurrency(item.unitPriceUsdc));
    rightText('/F1', 10, tableRight - 5, y, formatCurrency(item.amountUsdc));
    text('/F1', 8, colDesc, y - 10, escapePdfString(item.itemType));
    y -= 18;
  }

  line(tableLeft, y - 2, tableRight, y - 2);
  y -= 22;

  // Total
  strokeColor(0.2, 0.2, 0.2);
  w('0.5 w');
  line(tableLeft + 370, y - 2, tableRight, y - 2);
  strokeColor(0, 0, 0);
  text('/F2', 14, tableLeft + 375, y, 'Total:');
  rightText('/F2', 14, tableRight - 5, y, `${formatCurrency(data.totalAmountUsdc)} ${escapePdfString(data.currency)}`);

  y -= 40;

  // Footer
  strokeColor(0.5, 0.5, 0.5);
  w('0.5 w');
  line(MARGIN, y, PAGE_WIDTH - MARGIN, y);
  y -= 12;
  text('/F1', 8, MARGIN, y, 'Callora Platform - Billing Portal');
  y -= 10;
  text('/F1', 8, MARGIN, y, 'Thank you for your business!');

  w('Q');

  const streamContent = lines.join('\n');
  const streamBytes = Buffer.from(streamContent, 'ascii');

  const objects: string[] = [];
  let objCounter = 0;

  function obj(body: string): number {
    objCounter++;
    objects.push(`${objCounter} 0 obj\n${body}\nendobj`);
    return objCounter;
  }

  const fontHelveticaNum = obj('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const fontBoldNum = obj('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>');
  const fontCourierNum = obj('<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>');

  const resourcesNum = obj(
    `<< /Font << /F1 ${fontHelveticaNum} 0 R /F2 ${fontBoldNum} 0 R /F3 ${fontCourierNum} 0 R >> >>`,
  );

  obj(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] /Contents 4 0 R /Resources ${resourcesNum} 0 R >>`);
  obj(`<< /Length ${streamBytes.length} >> stream\n${streamContent}\nendstream`);
  obj('<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  obj('<< /Type /Catalog /Pages 2 0 R >>');

  // Build PDF
  const headerBuf = Buffer.from(`%PDF-1.4\n%\xFF\xFF\xFF\xFF\n`, 'ascii');
  const bodyParts: Buffer[] = [headerBuf];
  let offset = headerBuf.length;

  const xrefEntries: { num: number; offset: number }[] = [
    { num: 0, offset: 0 },
  ];

  for (let i = 0; i < objects.length; i++) {
    const entry = Buffer.from(objects[i] + '\n', 'ascii');
    xrefEntries.push({ num: i + 1, offset });
    bodyParts.push(entry);
    offset += entry.length;
  }

  const xrefOffset = offset;
  const xrefBody = `xref\n0 ${xrefEntries.length}\n${'0000000000 65535 f \n'}${xrefEntries
    .slice(1)
    .map((e) => String(e.offset).padStart(10, '0') + ' 00000 n ')
    .join('\n')}\n`;

  const trailer = `trailer\n<< /Size ${xrefEntries.length} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  bodyParts.push(Buffer.from(xrefBody, 'ascii'));
  bodyParts.push(Buffer.from(trailer, 'ascii'));

  return Buffer.concat(bodyParts);
}
