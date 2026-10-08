import type { Metadata } from 'next';
import { EvalsView } from '@/components/EvalsView';

export const metadata: Metadata = { title: 'Lumina · Evaluation' };

export default function EvalsPage() {
  return <EvalsView />;
}
