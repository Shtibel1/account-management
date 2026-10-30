import { redirect } from 'next/navigation';

/** /settings has no page of its own: open the office members page. */
export default function SettingsIndexPage() {
  redirect('/settings/members');
}
