// Payments happen outside the app. These build links that pre-fill the amount.

const dollars = (cents: number) => (cents / 100).toFixed(2);

export function venmoPayUrl(handle: string, cents: number, note: string): string {
  const params = new URLSearchParams({
    txn: 'pay',
    audience: 'private',
    recipients: handle.replace(/^@/, ''),
    amount: dollars(cents),
    note,
  });
  return `https://venmo.com/?${params.toString()}`;
}

export function cashAppPayUrl(cashtag: string, cents: number): string {
  return `https://cash.app/$${cashtag.replace(/^\$/, '')}/${dollars(cents)}`;
}
