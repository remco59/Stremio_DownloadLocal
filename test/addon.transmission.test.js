// Transmission with an incomplete dir: partial files live in /downloads/incomplete/<name>.part until done.
require('./helpers/addon-suite')({
  client: 'transmission',
  mockOpts: { incompleteDir: '/downloads/incomplete' },
  partial: { dir: 'incomplete', suffix: '.part' },
});
