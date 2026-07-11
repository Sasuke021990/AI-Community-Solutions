import { useState } from 'react';
import { type View, topLevelFor } from './view.js';
import { SpacesHomeScreen } from './screens/SpacesHomeScreen.js';
import { SpaceBuilderScreen } from './screens/SpaceBuilderScreen.js';
import { PresetGalleryScreen } from './screens/PresetGalleryScreen.js';
import { RunScreen } from './screens/RunScreen.js';
import { RunHistoryScreen } from './screens/RunHistoryScreen.js';
import { McpRegistryScreen } from './screens/McpRegistryScreen.js';
import { SettingsScreen } from './screens/SettingsScreen.js';

const TOP_LEVEL_NAV: { key: 'spaces' | 'mcp' | 'settings'; label: string; view: View }[] = [
  { key: 'spaces', label: 'Spaces', view: { name: 'spaces' } },
  { key: 'mcp', label: 'MCP Servers', view: { name: 'mcp' } },
  { key: 'settings', label: 'Settings', view: { name: 'settings' } }
];

function App() {
  const [view, setView] = useState<View>({ name: 'spaces' });
  const activeTopLevel = topLevelFor(view);

  let content;
  switch (view.name) {
    case 'spaces':
      content = (
        <SpacesHomeScreen
          onOpenPresets={() => setView({ name: 'presets' })}
          onOpenBuilder={(spaceId) => setView({ name: 'builder', spaceId })}
          onOpenRun={(spaceId) => setView({ name: 'run', spaceId })}
        />
      );
      break;
    case 'builder':
      content = (
        <SpaceBuilderScreen
          spaceId={view.spaceId}
          onCreated={(id) => setView({ name: 'builder', spaceId: id })}
          onOpenRun={(spaceId) => setView({ name: 'run', spaceId })}
          onPublished={() => setView({ name: 'spaces' })}
          onBack={() => setView({ name: 'spaces' })}
        />
      );
      break;
    case 'presets':
      content = (
        <PresetGalleryScreen
          onOpenBuilder={(spaceId) => setView({ name: 'builder', spaceId })}
          onBack={() => setView({ name: 'spaces' })}
        />
      );
      break;
    case 'run':
      content = (
        <RunScreen
          spaceId={view.spaceId}
          onOpenHistory={(spaceId) => setView({ name: 'history', spaceId })}
          onBack={() => setView({ name: 'spaces' })}
        />
      );
      break;
    case 'history':
      content = <RunHistoryScreen spaceId={view.spaceId} onBack={() => setView({ name: 'spaces' })} />;
      break;
    case 'mcp':
      content = <McpRegistryScreen />;
      break;
    case 'settings':
      content = <SettingsScreen />;
      break;
  }

  return (
    <div className="app-shell">
      <div className="sidebar">
        <div className="sidebar-title">AI Community Solutions</div>
        {TOP_LEVEL_NAV.map((item) => (
          <button
            key={item.key}
            className={`nav-item ${activeTopLevel === item.key ? 'active' : ''}`}
            onClick={() => setView(item.view)}
          >
            {item.label}
          </button>
        ))}
      </div>
      <div className="main">{content}</div>
    </div>
  );
}

export default App;
