import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import App from './App';

vi.mock('./modules/window/TitleBar', () => ({
  TitleBar: () => <div data-testid="title-bar">TitleBar</div>,
}));

vi.mock('./modules/modals/ModalRenderer', () => ({
  ModalRenderer: () => null,
}));

describe('App', () => {
  it('renders without crashing', async () => {
    render(<App />);
    
    await waitFor(() => {
      expect(screen.getByTestId('title-bar')).toBeInTheDocument();
    });
  });

  it('shows loading state initially', () => {
    render(<App />);
    
    expect(screen.getByText('Loading...')).toBeInTheDocument();
  });

  it('shows WelcomeScreen after initialization when no folder is set', async () => {
    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('RapidRAW')).toBeInTheDocument();
    });
  });
});
