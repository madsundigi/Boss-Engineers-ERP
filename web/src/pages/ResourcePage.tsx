import { useParams } from 'react-router-dom';
import { findResource } from '../app/registry';
import { ResourceList } from '../components/ResourceList';

export function ResourcePage() {
  const { path } = useParams<{ path: string }>();
  const def = path ? findResource(path) : undefined;
  if (!def) {
    return (
      <div className="erp-page">
        <div className="erp-alert erp-alert--error">Unknown module “{path}”.</div>
      </div>
    );
  }
  // key forces a fresh mount (and refetch) when navigating between resources.
  return <ResourceList key={def.path} def={def} />;
}
