import {
  MAX_TEXT_MATERIAL_CHARS,
  TRIP_BOOKING_STATUSES,
  TRIP_CONTACT_ROLES,
  TRIP_LEG_MODES,
  buildExtractionTool,
  buildMaterialContentBlock,
  isExtractableMimeType,
} from './trip-extraction';

describe('isExtractableMimeType', () => {
  it('принимает PDF/изображения/текст/csv', () => {
    expect(isExtractableMimeType('application/pdf')).toBe(true);
    expect(isExtractableMimeType('image/png')).toBe(true);
    expect(isExtractableMimeType('image/jpeg')).toBe(true);
    expect(isExtractableMimeType('text/plain')).toBe(true);
    expect(isExtractableMimeType('text/csv')).toBe(true);
  });

  it('отклоняет docx/xlsx — нет мультимодального блока под них', () => {
    expect(isExtractableMimeType('application/vnd.openxmlformats-officedocument.wordprocessingml.document')).toBe(false);
    expect(isExtractableMimeType('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')).toBe(false);
  });
});

describe('buildExtractionTool', () => {
  it('требует все поля верхнего уровня и запрещает лишние', () => {
    const tool = buildExtractionTool();
    expect(tool.input_schema.required).toEqual(['readable', 'summaryHint', 'destinationHint', 'legs', 'events', 'stays', 'contacts', 'facts', 'issues']);
    expect(tool.input_schema.additionalProperties).toBe(false);
  });

  it('enum TripLegMode/TripBookingStatus/TripContactRole совпадают со схемой Prisma', () => {
    const tool = buildExtractionTool();
    const props = tool.input_schema.properties as Record<string, unknown>;
    const legItems = (props.legs as { items: { properties: Record<string, { enum?: string[] }> } }).items.properties;
    expect(legItems.mode.enum).toEqual([...TRIP_LEG_MODES]);
    expect(legItems.bookingStatus.enum).toEqual([...TRIP_BOOKING_STATUSES]);
    const contactItems = (props.contacts as { items: { properties: Record<string, { enum?: string[] }> } }).items.properties;
    expect(contactItems.role.enum).toEqual([...TRIP_CONTACT_ROLES]);
  });
});

describe('buildMaterialContentBlock', () => {
  it('PDF -> document-блок с base64', () => {
    const block = buildMaterialContentBlock(Buffer.from('%PDF-1.4'), 'application/pdf', 'ticket.pdf');
    expect(block).toEqual({
      type: 'document',
      title: 'ticket.pdf',
      source: { type: 'base64', media_type: 'application/pdf', data: Buffer.from('%PDF-1.4').toString('base64') },
    });
  });

  it('PNG -> image-блок с base64', () => {
    const block = buildMaterialContentBlock(Buffer.from([1, 2, 3]), 'image/png', 'screen.png');
    expect(block).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: Buffer.from([1, 2, 3]).toString('base64') } });
  });

  it('text/plain -> текстовый блок, обрезанный по MAX_TEXT_MATERIAL_CHARS', () => {
    const longText = 'a'.repeat(MAX_TEXT_MATERIAL_CHARS + 500);
    const block = buildMaterialContentBlock(Buffer.from(longText, 'utf-8'), 'text/plain', 'notes.txt');
    expect(block).toEqual({ type: 'text', text: longText.slice(0, MAX_TEXT_MATERIAL_CHARS) });
  });

  it('docx — нет блока (null), вызывающий код должен не отправлять такой материал в модель', () => {
    expect(buildMaterialContentBlock(Buffer.from('zip-bytes'), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'program.docx')).toBeNull();
  });
});
