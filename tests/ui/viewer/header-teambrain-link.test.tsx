import { describe, expect, it } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Header } from '../../../src/ui/viewer/components/Header.js';

// husni fork: the viewer header carries no TeamBrain pitch.
describe('viewer header TeamBrain link', () => {
  it('is never shown', () => {
    const html = renderToStaticMarkup(
      <Header
        projects={[]}
        currentFilter=""
        onFilterChange={() => {}}
        isProcessing={false}
        queueDepth={0}
        themePreference="system"
        onThemeChange={() => {}}
        onContextPreviewToggle={() => {}}
      />,
    );
    expect(html).not.toContain('teambrain-cta');
    expect(html).not.toContain('TeamBrain');
  });
});
