import './global.css';

export const metadata = {
  title: 'Auth platform',
  description: 'Sign-in, registration and the api-gateway endpoint surface',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
