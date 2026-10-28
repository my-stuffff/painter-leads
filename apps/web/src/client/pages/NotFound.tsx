import { Compass } from 'lucide-react';
import { Link } from 'react-router';
import { EmptyState, PageBody, PageHeader } from '../components/Page';
import { buttonClass, Panel } from '../components/ui';

export function NotFoundPage({ title = 'Page not found' }: { title?: string }) {
  return (
    <PageBody>
      <PageHeader title={title} back="/" />
      <Panel>
        <EmptyState
          icon={<Compass className="size-5" />}
          title="Nothing here"
          action={
            <Link to="/" className={buttonClass('primary')}>
              Go home
            </Link>
          }
        />
      </Panel>
    </PageBody>
  );
}
