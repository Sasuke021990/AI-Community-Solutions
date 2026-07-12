
interface NewSpaceChooserScreenProps {
  onSelectPipeline: () => void;
  onSelectCustom: () => void;
  onBack: () => void;
}

export function NewSpaceChooserScreen({ onSelectPipeline, onSelectCustom, onBack }: NewSpaceChooserScreenProps) {
  return (
    <div>
      <div className="page-header">
        <div>
          <button className="btn-link" onClick={onBack} style={{ paddingLeft: 0, marginBottom: 8 }}>
            &larr; Spaces
          </button>
          <h1>Create New Space</h1>
          <p className="subtitle">Choose how you want to build your team of agents.</p>
        </div>
      </div>
      <div className="card-grid">
        <div className="card card-clickable" onClick={onSelectPipeline}>
          <h3>Pipeline (Structured)</h3>
          <p className="subtitle" style={{ marginTop: 8 }}>Agents run in a fixed, code-guaranteed order.</p>
        </div>
        <div className="card card-clickable" onClick={onSelectCustom}>
          <h3>Custom Space (Advanced)</h3>
          <p className="subtitle" style={{ marginTop: 8 }}>Build an orchestrator or round-robin team.</p>
        </div>
      </div>
    </div>
  );
}
