/**
 * @fileoverview Shared inline-style constants and a plural helper for the storefront pages.
 *
 * @remarks The product grids have no class in the module stylesheets — they are inline because
 * they are the page's own arrangement — and they are shared so the pages cannot drift apart.
 */

export const GRID_LIST_STYLE = {
  listStyle: 'none',
  padding: 0,
  display: 'grid',
  gap: '0.75rem',
};

export const GRID_LIST_STYLE_DENSE = {
  listStyle: 'none',
  padding: 0,
  display: 'grid',
  gap: '0.5rem',
};

export const GRID_LIST_STYLE_TIGHT = {
  listStyle: 'none',
  padding: 0,
  display: 'grid',
  gap: '0.35rem',
};

/** The suffix a count takes: singular at one, plural otherwise. */
export function pluralSuffix(count: number): string {
  return count === 1 ? '' : 's';
}
