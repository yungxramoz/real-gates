// @vitest-environment happy-dom
import { render, screen } from '@testing-library/react';
import { expect, test } from 'vite-plus/test';

import { App } from './App.tsx';

test('the first screen has one heading', () => {
  render(<App />);
  expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
});
