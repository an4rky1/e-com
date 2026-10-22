import React from 'react';
import { render, screen } from '@testing-library/react';
import Page from '../src/app/page';

describe('Page', () => {
  it('renders the sign-in form', () => {
    render(<Page />);

    // Plain jest matchers, not jest-dom's: the setup file that teaches `toBeInTheDocument` is
    // not part of this workspace, and a matcher that does not exist fails as a test failure
    // rather than as a missing dependency.
    expect(screen.getByLabelText('Email')).toBeTruthy();
    expect(screen.getByLabelText('Password')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeTruthy();
  });
});
