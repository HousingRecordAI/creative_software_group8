import { useState, useEffect, useMemo, useRef } from 'react';
import { Camera, FileText, Settings, ArrowLeft, CheckCircle2, ChevronRight, Image as ImageIcon, ShieldCheck, AlertTriangle, ScanLine, Home } from 'lucide-react';
import walkthroughData from './walkthrough.json';
import { loadAppData, saveAppData, clearAppData, type PersistentData, type InspectionPhase } from './lib/storage';
import { computeHash } from './lib/hash';
import { submitMoveInReport, submitMoveOutReport, analyzeImage, type DiscrepancyResult, type AnalysisData } from './lib/api';
import ImageUpload from './components/ImageUpload';
import AnalysisResult from './components/AnalysisResult';

type AppState = 'setup' | 'hub' | 'wizard' | 'report' | 'processing' | 'analyze';

type Room = { id: string; name: string; steps: { id: string; label: string; guide: string }[] };

const ROOM_TYPES = [
  { id: 'bedroom',     label: '방',    emoji: '🛏', color: '#818CF8' },
  { id: 'bathroom',    label: '화장실', emoji: '🚿', color: '#38BDF8' },
  { id: 'kitchen',     label: '부엌',  emoji: '🍳', color: '#FB923C' },
  { id: 'living-room', label: '거실',  emoji: '🛋', color: '#34D399' },
];

export default function App() {
  const [view, setView] = useState<AppState>('hub');
  const [selectedRoomId, setSelectedRoomId] = useState<string | null>(null);
  const [currentStepIndex, setCurrentStepIndex] = useState(0);
  const [data, setData] = useState<PersistentData>({ photos: { 'move-in': {}, 'move-out': {} }, currentPhase: 'move-in' });
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [discrepancies, setDiscrepancies] = useState<DiscrepancyResult[]>([]);
  const [analyzeResult, setAnalyzeResult] = useState<AnalysisData | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analyzeError, setAnalyzeError] = useState<string | null>(null);
  const [setupCounts, setSetupCounts] = useState<Record<string, number>>(
    Object.fromEntries(ROOM_TYPES.map(t => [t.id, 0]))
  );

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const rooms = useMemo((): Room[] => {
    if (!data.roomConfig) return walkthroughData.rooms as Room[];
    const result: Room[] = [];
    for (const type of ROOM_TYPES) {
      const count = data.roomConfig[type.id] ?? 0;
      if (count === 0) continue;
      const template = walkthroughData.rooms.find(r => r.id === type.id);
      if (!template) continue;
      for (let i = 1; i <= count; i++) {
        result.push({
          ...template,
          id: count > 1 ? `${type.id}-${i}` : type.id,
          name: count > 1 ? `${type.label} ${i}` : type.label,
        });
      }
    }
    return result;
  }, [data.roomConfig]);

  const currentRoom = useMemo(() => rooms.find(r => r.id === selectedRoomId), [selectedRoomId, rooms]);
  const currentStep = useMemo(() => currentRoom?.steps[currentStepIndex], [currentRoom, currentStepIndex]);

  useEffect(() => {
    loadAppData().then(loadedData => {
      setData(loadedData);
      if (!loadedData.roomConfig) setView('setup');
      setIsLoading(false);
    });
  }, []);

  useEffect(() => {
    if (!isLoading) saveAppData(data);
  }, [data, isLoading]);

  useEffect(() => {
    let stream: MediaStream | null = null;
    if (view === 'wizard' && videoRef.current) {
      navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false })
        .then(s => { stream = s; if (videoRef.current) videoRef.current.srcObject = s; setCameraError(null); })
        .catch(err => { console.error(err); setCameraError('카메라 접근이 거부되었습니다.'); });
    }
    return () => { stream?.getTracks().forEach(t => t.stop()); };
  }, [view]);

  const handleSetupConfirm = () => {
    const config: Record<string, number> = {};
    for (const [key, value] of Object.entries(setupCounts)) {
      if (value > 0) config[key] = value;
    }
    setData(prev => ({ ...prev, roomConfig: config }));
    setView('hub');
  };

  const enterRoom = (id: string) => { setSelectedRoomId(id); setCurrentStepIndex(0); setView('wizard'); };

  const capturePhoto = () => {
    if (!selectedRoomId || !currentStep || !videoRef.current || !canvasRef.current) return;
    const video = videoRef.current;
    const canvas = canvasRef.current;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const newPhoto = canvas.toDataURL('image/jpeg', 0.8);
    setData(prev => {
      const phase = prev.currentPhase;
      const phasePhotos = prev.photos[phase] || {};
      const roomPhotos = phasePhotos[selectedRoomId] || {};
      const stepPhotos = roomPhotos[currentStep.id] || [];
      return {
        ...prev,
        photos: {
          ...prev.photos,
          [phase]: { ...phasePhotos, [selectedRoomId]: { ...roomPhotos, [currentStep.id]: [...stepPhotos, newPhoto] } }
        }
      };
    });
  };

  const nextStep = () => {
    if (currentRoom && currentStepIndex < currentRoom.steps.length - 1) {
      setCurrentStepIndex(prev => prev + 1);
    } else {
      setView('hub');
    }
  };

  const getStepPhotos = (phase: InspectionPhase, roomId: string, stepId: string) =>
    data.photos[phase]?.[roomId]?.[stepId] || [];

  const getFirstPhotoInRoom = (phase: InspectionPhase, roomId: string) => {
    const roomPhotos = data.photos[phase]?.[roomId] || {};
    for (const stepId in roomPhotos) {
      if (roomPhotos[stepId]?.[0]) return roomPhotos[stepId][0];
    }
    return null;
  };

  const handleFinalizeReport = async () => {
    setIsSubmitting(true);
    setView('processing');
    try {
      if (data.currentPhase === 'move-in') {
        const imageHashes: Record<string, string> = {};
        const moveInPhotos = data.photos['move-in'];
        for (const roomId in moveInPhotos) {
          for (const stepId in moveInPhotos[roomId]) {
            const photos = moveInPhotos[roomId][stepId];
            if (photos.length > 0) imageHashes[`${roomId}-${stepId}`] = await computeHash(photos[0]);
          }
        }
        const response = await submitMoveInReport({
          timestamp: Date.now(),
          metadata: { rooms: rooms.map(r => ({ id: r.id, name: r.name })) },
          imageHashes
        });
        setData(prev => ({ ...prev, blockchainProof: response, currentPhase: 'move-out' }));
      } else {
        const results = await submitMoveOutReport(data.photos['move-in'], data.photos['move-out']);
        setDiscrepancies(results);
      }
      setView('report');
    } catch (error) {
      console.error(error);
      alert('처리에 실패했습니다. 다시 시도해주세요.');
      setView('hub');
    } finally {
      setIsSubmitting(false);
    }
  };

  if (isLoading) return (
    <div className="loading-screen">
      <div className="loading-logo">
        <Home size={32} color="#1A1E2D" />
      </div>
      <div className="spinner" />
    </div>
  );

  const currentPhasePhotos = data.photos[data.currentPhase];
  const currentPhotos = selectedRoomId && currentStep ? getStepPhotos(data.currentPhase, selectedRoomId, currentStep.id) : [];
  const lastPhoto = currentPhotos[currentPhotos.length - 1];

  const totalCompleted = rooms.filter(room =>
    room.steps.length > 0 && room.steps.every(s => getStepPhotos(data.currentPhase, room.id, s.id).length > 0)
  ).length;

  return (
    <div className="app">

      {/* ── SETUP ── */}
      {view === 'setup' && (
        <div className="setup-view">
          <div className="view-hero">
            <div className="setup-hero-inner">
              <div className="setup-app-icon">
                <Home size={36} color="white" />
              </div>
              <h1>House Record</h1>
              <p>촬영할 공간의 종류와 개수를<br />설정해 주세요.</p>
            </div>
          </div>
          <div className="view-shelf">
            <p className="section-title">공간 구성</p>
            <div className="setup-list">
              {ROOM_TYPES.map(type => (
                <div key={type.id} className="setup-row">
                  <div className="setup-row-info">
                    <div className="setup-room-icon" style={{ background: `${type.color}20`, border: `1.5px solid ${type.color}35` }}>
                      <span>{type.emoji}</span>
                    </div>
                    <span className="setup-label">{type.label}</span>
                  </div>
                  <div className="setup-counter">
                    <button
                      className="counter-btn"
                      onClick={() => setSetupCounts(prev => ({ ...prev, [type.id]: Math.max(0, (prev[type.id] || 0) - 1) }))}
                      disabled={(setupCounts[type.id] || 0) === 0}
                    >−</button>
                    <span className="counter-value">{setupCounts[type.id] || 0}</span>
                    <button
                      className="counter-btn"
                      onClick={() => setSetupCounts(prev => ({ ...prev, [type.id]: Math.min(9, (prev[type.id] || 0) + 1) }))}
                    >+</button>
                  </div>
                </div>
              ))}
            </div>
            <div className="setup-footer">
              <button
                className="cta-btn-dark"
                disabled={Object.values(setupCounts).every(v => v === 0)}
                onClick={handleSetupConfirm}
              >
                시작하기
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── HUB ── */}
      {view === 'hub' && (
        <div className="hub-container">
          <div className="view-hero">
            <div className="hero-app-name">
              <Home size={15} color="rgba(255,255,255,0.75)" />
              <span>House Record</span>
            </div>
            <div className={`hero-phase-pill ${data.currentPhase}`}>
              <span className="phase-pill-dot" />
              {data.currentPhase === 'move-in' ? 'STEP 1 · 입주 전' : 'STEP 2 · 퇴실'}
            </div>
            <h1 className="hero-title">
              {data.currentPhase === 'move-in' ? '입주 전 점검' : '퇴실 점검'}
            </h1>
            <p className="hero-subtitle">각 공간의 상태를 촬영하세요.</p>
            <p className="hero-stat">{totalCompleted}/{rooms.length} 공간 촬영 완료</p>
            <div className="hero-progress-bar">
              <div
                className="hero-progress-fill"
                style={{ width: rooms.length > 0 ? `${(totalCompleted / rooms.length) * 100}%` : '0%' }}
              />
            </div>
          </div>

          <div className="view-shelf">
            <p className="section-title">공간 목록</p>
            <div className="room-grid">
              {rooms.map(room => {
                const firstPhoto = getFirstPhotoInRoom(data.currentPhase, room.id);
                const completedSteps = room.steps.filter(s => getStepPhotos(data.currentPhase, room.id, s.id).length > 0).length;
                const isFullyDone = completedSteps === room.steps.length && room.steps.length > 0;
                const roomTypeId = room.id.replace(/-\d+$/, '');
                const roomType = ROOM_TYPES.find(t => t.id === roomTypeId);
                const roomColor = roomType?.color ?? '#818CF8';

                return (
                  <button key={room.id} className="room-card" onClick={() => enterRoom(room.id)}>
                    <div
                      className="room-card-icon-wrap"
                      style={{ background: `${roomColor}1A` }}
                    >
                      {firstPhoto
                        ? <img src={firstPhoto} className="room-card-photo" />
                        : <span className="room-card-emoji">{roomType?.emoji ?? '🏠'}</span>
                      }
                      {isFullyDone && (
                        <div className="room-card-done-badge">
                          <CheckCircle2 size={11} color="white" />
                        </div>
                      )}
                    </div>
                    <div className="room-card-body">
                      <h3>{room.name}</h3>
                      <div className={`room-step-pill ${isFullyDone ? 'done' : ''}`}>
                        {isFullyDone ? '✓ 완료' : `${completedSteps}/${room.steps.length} 단계`}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>

            <div className="finalize-area">
              <button
                className="cta-btn"
                onClick={handleFinalizeReport}
                disabled={Object.keys(currentPhasePhotos).length === 0}
              >
                {data.currentPhase === 'move-in' ? '입주 보고서 생성하기' : '퇴실 비교 분석하기'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── WIZARD ── */}
      {view === 'wizard' && currentRoom && currentStep && (
        <div className="wizard-view">
          <div className="wizard-camera-container">
            <div className="wizard-top-bar">
              <button className="wizard-back-btn" onClick={() => setView('hub')}>
                <ArrowLeft size={20} />
              </button>
              <div className="wizard-title">
                <h2>{currentRoom.name}</h2>
              </div>
              <div style={{ width: 40 }} />
            </div>

            <div className="wizard-step-dots">
              {currentRoom.steps.map((_, i) => (
                <div
                  key={i}
                  className={`step-dot ${i < currentStepIndex ? 'done' : i === currentStepIndex ? 'active' : ''}`}
                />
              ))}
            </div>

            {cameraError ? (
              <div className="camera-error">
                <Camera size={48} />
                <p>{cameraError}</p>
                <small>브라우저 카메라 권한을 확인하세요.</small>
              </div>
            ) : (
              <video ref={videoRef} autoPlay playsInline />
            )}

            <div className="wizard-guide">
              <div className="wizard-guide-label">{currentStep.label}</div>
              <p>{currentStep.guide}</p>
            </div>
          </div>

          <canvas ref={canvasRef} style={{ display: 'none' }} />

          <div className="wizard-bottom-bar">
            <div className="wizard-thumbnail">
              {lastPhoto ? <img src={lastPhoto} /> : <ImageIcon size={18} color="#CBD5E4" />}
            </div>
            <button className="shutter-btn" onClick={capturePhoto}>
              <div className="shutter-inner" />
            </button>
            <button className="wizard-next-btn" onClick={nextStep}>
              {currentStepIndex === currentRoom.steps.length - 1
                ? <CheckCircle2 size={20} color="white" />
                : <ChevronRight size={20} color="white" />
              }
            </button>
          </div>
        </div>
      )}

      {/* ── ANALYZE ── */}
      {view === 'analyze' && (
        <div className="analyze-view">
          <div className="view-hero">
            <div className="hero-app-name">
              <ScanLine size={15} color="rgba(255,255,255,0.75)" />
              <span>하자 분석</span>
            </div>
            <h1 className="hero-title">AI 하자 분석</h1>
            <p className="hero-subtitle">이미지를 업로드하면 AI가 자동으로 분석합니다.</p>
          </div>
          <div className="view-shelf">
            <div className="analyze-body" style={{ padding: '0' }}>
              <ImageUpload
                disabled={isAnalyzing}
                onImageSelect={async (file) => {
                  setAnalyzeResult(null);
                  setAnalyzeError(null);
                  setIsAnalyzing(true);
                  try {
                    const result = await analyzeImage(file);
                    setAnalyzeResult(result);
                  } catch (err) {
                    setAnalyzeError(err instanceof Error ? err.message : '분석에 실패했습니다.');
                  } finally {
                    setIsAnalyzing(false);
                  }
                }}
              />
              {isAnalyzing && (
                <div className="analyze-loading">
                  <div className="spinner" />
                  <p>AI 분석 중...</p>
                </div>
              )}
              {analyzeError && <div className="analyze-error"><p>{analyzeError}</p></div>}
              {analyzeResult && !isAnalyzing && <AnalysisResult result={analyzeResult} />}
            </div>
          </div>
        </div>
      )}

      {/* ── PROCESSING ── */}
      {view === 'processing' && (
        <div className="processing-view">
          <div className="processing-orb">
            <div className="spinner" />
          </div>
          <h2>{data.currentPhase === 'move-out' ? '블록체인 저장 중...' : 'AI 분석 중...'}</h2>
          <p>데이터를 안전하게 처리하고 있습니다.</p>
        </div>
      )}

      {/* ── REPORT ── */}
      {view === 'report' && (
        <div className="report-view">
          <div className="view-hero">
            <div className="report-success-inner">
              <div className="report-success-icon">
                <CheckCircle2 size={36} color="white" />
              </div>
              <h1>{discrepancies.length > 0 ? '분석 완료' : '보고서 저장 완료'}</h1>
              <p>점검 데이터가 처리되었습니다.</p>
            </div>
          </div>

          <div className="view-shelf">
            {data.blockchainProof && (
              <div className="proof-card">
                <div className="proof-header">
                  <ShieldCheck size={15} />
                  <span>블록체인 검증 완료</span>
                </div>
                <div className="proof-body">
                  <div className="proof-item">
                    <label>Data Hash</label>
                    <code>{data.blockchainProof.hash.substring(0, 32)}...</code>
                  </div>
                  <div className="proof-item">
                    <label>Transaction ID</label>
                    <code>{data.blockchainProof.txId.substring(0, 32)}...</code>
                  </div>
                  <div className="proof-item">
                    <label>Timestamp</label>
                    <span>{new Date(data.blockchainProof.timestamp).toLocaleString()}</span>
                  </div>
                </div>
              </div>
            )}

            {discrepancies.length > 0 && (
              <div className="discrepancy-list" style={{ marginBottom: '1.25rem' }}>
                <h3>AI 탐지 결과</h3>
                {discrepancies.map((d, i) => (
                  <div key={i} className={`discrepancy-item ${d.damageLevel}`}>
                    <div className="item-header">
                      {d.damageLevel !== 'none' && (
                        <AlertTriangle size={16} color={d.damageLevel === 'high' ? '#f43f5e' : '#f59e0b'} />
                      )}
                      <span className="room-step">{d.roomId} · {d.stepId}</span>
                      <span className={`badge ${d.damageLevel}`}>{d.damageLevel.toUpperCase()}</span>
                    </div>
                    <p>{d.notes}</p>
                  </div>
                ))}
              </div>
            )}

            <div className="report-actions">
              <button className="cta-btn" onClick={() => setView('hub')}>다시 촬영하기</button>
              {data.currentPhase === 'move-out' && (
                <button
                  className="danger-btn"
                  onClick={async () => {
                    if (confirm('모든 데이터를 초기화하시겠습니까?')) {
                      await clearAppData();
                      window.location.reload();
                    }
                  }}
                >
                  새 점검 시작하기
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── BOTTOM NAV ── */}
      {view !== 'wizard' && view !== 'processing' && view !== 'setup' && (
        <nav className="bottom-nav">
          <button className={`nav-item ${view === 'hub' ? 'active' : ''}`} onClick={() => setView('hub')}>
            <Home size={22} />
            <span>홈</span>
          </button>
          <button className={`nav-item ${view === 'analyze' ? 'active' : ''}`} onClick={() => setView('analyze')}>
            <ScanLine size={22} />
            <span>분석</span>
          </button>
          <button className={`nav-item ${view === 'report' ? 'active' : ''}`} onClick={() => setView('report')}>
            <FileText size={22} />
            <span>보고서</span>
          </button>
          <button
            className="nav-item"
            onClick={() => {
              if (confirm('방 구성을 다시 설정하시겠습니까?')) {
                setSetupCounts(Object.fromEntries(ROOM_TYPES.map(t => [t.id, 0])));
                setData(prev => { const next = { ...prev }; delete next.roomConfig; return next; });
                setView('setup');
              }
            }}
          >
            <Settings size={22} />
            <span>설정</span>
          </button>
        </nav>
      )}
    </div>
  );
}
