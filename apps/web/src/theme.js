import { createTheme } from '@mantine/core';

// The workshop palette: indigo dye, kumkum red, haldi yellow, neem green on cool chalk.
// Each tuple is centred on its token at shade 6 (Mantine's primary shade in light mode).
const indigo = ['#EEEFF7', '#DCDEEE', '#B8BBDC', '#9196C9', '#6D72B3', '#4F549A', '#2E336B', '#272B5C', '#20234C', '#181A3A'];
const kumkum = ['#FBEDEF', '#F5D6DB', '#EBADB7', '#E08292', '#D35A70', '#C54259', '#B8324A', '#9C2A3F', '#7F2233', '#611A27'];
const haldi = ['#FCF5E6', '#F7E8C6', '#EFD18F', '#E6B957', '#DDA42D', '#D3961B', '#C98A12', '#A8730F', '#875C0C', '#664609'];
const neem = ['#EBF4EE', '#D3E7DA', '#A8CFB6', '#7DB792', '#5AA275', '#468F63', '#3C7A56', '#326648', '#28523A', '#1E3D2B'];

export const tokens = Object.freeze({
  indigo: '#2E336B',
  ink: '#1C1F3A',
  chalk: '#F4F5F9',
  kumkum: '#B8324A',
  haldi: '#C98A12',
  neem: '#3C7A56',
  rule: '#DADCE8',
  muted: '#5C607A',
});

const UI_FONT = 'Figtree, system-ui, -apple-system, "Segoe UI", sans-serif';
export const DISPLAY_FONT = '"Young Serif", Georgia, serif';

export const theme = createTheme({
  colors: { indigo, kumkum, haldi, neem, red: kumkum, yellow: haldi, green: neem },
  primaryColor: 'indigo',
  primaryShade: 6,
  black: tokens.ink,
  fontFamily: UI_FONT,
  fontFamilyMonospace: 'ui-monospace, Consolas, monospace',
  fontSizes: { xs: '13px', sm: '15px', md: '15px', lg: '18px', xl: '24px' },
  lineHeights: { xs: '1.45', sm: '1.55', md: '1.55', lg: '1.45', xl: '1.3' },
  headings: {
    fontFamily: UI_FONT,
    fontWeight: '600',
    sizes: {
      h1: { fontSize: '32px', lineHeight: '1.2' },
      h2: { fontSize: '24px', lineHeight: '1.25' },
      h3: { fontSize: '18px', lineHeight: '1.35' },
      h4: { fontSize: '15px', lineHeight: '1.45' },
    },
  },
  radius: { xs: '4px', sm: '6px', md: '10px', lg: '10px', xl: '10px' },
  defaultRadius: 'sm',
  shadows: { md: '0 8px 24px rgba(28, 31, 58, 0.14)', lg: '0 12px 32px rgba(28, 31, 58, 0.16)' },
  focusRing: 'auto',
  cursorType: 'pointer',
  other: { chalk: tokens.chalk, rule: tokens.rule, ink: tokens.ink },
  components: {
    Paper: { defaultProps: { radius: 'md' } },
    Modal: { defaultProps: { radius: 'md', shadow: 'lg' } },
    Drawer: { defaultProps: { shadow: 'lg' } },
    Menu: { defaultProps: { shadow: 'md', radius: 'md' } },
    Badge: { defaultProps: { tt: 'none' } },
    Button: { defaultProps: { fw: 600 } },
  },
});
