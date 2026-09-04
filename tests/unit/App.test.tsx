import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it } from 'vitest';
import { App } from '../../src/app/App';
import { createAppStore } from '../../src/app/appStore';

it('opens course selection from the title screen', async () => {
  const user = userEvent.setup();

  render(<App store={createAppStore()} />);
  await user.click(screen.getByRole('button', { name: 'Dive in' }));

  expect(
    screen.getByRole('heading', { name: 'Choose a course' }),
  ).toBeVisible();
});
