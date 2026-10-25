import { describe, expect, it } from 'vitest';
import { classifyPainter } from '../src/filter';

describe('non-painter filter (R6, D-24, QUAL-01)', () => {
  it.each([
    [['Painter'], 'Acme Painting'],
    [['House painter', 'Contractor'], 'Smith & Sons'],
    [['Painting contractor'], 'Edison Pros'],
    [['Commercial painter'], 'Dave Co'],
    [['Interior painter'], 'X'],
    [['Exterior painter'], 'X'],
    [['Painting'], 'X'],
  ])('keeps %s', (categories, name) => {
    expect(classifyPainter(categories, name).status).toBe('painter');
  });

  it('keeps a listing whose name says painting and whose category is a contractor type', () => {
    const d = classifyPainter(['General contractor'], 'Acme Painting');
    expect(d).toMatchObject({ status: 'painter', category: 'General contractor' });
    expect(classifyPainter(['Drywall contractor'], 'Quality Coatings').status).toBe('painter');
    expect(classifyPainter(['Handyman'], 'Joes Paint and Repair').status).toBe('painter');
  });

  it('marks a paint store not a painting contractor, with the deciding category', () => {
    expect(classifyPainter(['Paint store'], 'Sherwin-Williams Paint Store')).toMatchObject({
      status: 'not_painter',
      category: 'Paint store',
    });
  });

  it('marks art studios and paint-and-sip classes not a painter even though the name says painting', () => {
    expect(classifyPainter(['Art studio'], 'Painting with a Twist')).toMatchObject({ status: 'not_painter', category: 'Art studio' });
    expect(classifyPainter(['Painting lessons'], 'Paint Nite').status).toBe('not_painter');
    expect(classifyPainter(['Paint and sip studio'], 'Sip and Paint').status).toBe('not_painter');
  });

  it.each([
    ['Auto body shop'],
    ['Auto painting'],
    ['Car detailing service'],
    ['Mural artist'],
    ['Paint manufacturer'],
    ['Wallpaper store'],
    ['Wallpaper installer'],
    ['Interior designer'],
  ])('marks %s not a painting contractor', (category) => {
    expect(classifyPainter([category], 'Some Business')).toMatchObject({ status: 'not_painter', category });
  });

  it('a painter category beats a non-painter one on the same listing', () => {
    expect(classifyPainter(['Wallpaper installer', 'Painter'], 'Walls Etc').status).toBe('painter');
    expect(classifyPainter(['Interior designer', 'House painter'], 'Design and Paint').status).toBe('painter');
  });

  it('keeps an unrecognised category for review (unknown), never silently as a painter or a non-painter', () => {
    const d = classifyPainter(['Landscaper'], 'Green Lawns');
    expect(d.status).toBe('unknown');
    expect(d.reason).toContain('Landscaper');
    expect(classifyPainter([], 'Acme Painting').status).toBe('unknown');
    expect(classifyPainter(['Contractor'], 'Acme Builders').status).toBe('unknown');
  });

  it('names alone do not make a painter without a contractor category', () => {
    expect(classifyPainter(['Gift shop'], 'Paint the Town Gifts').status).toBe('unknown');
  });
});
