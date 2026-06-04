import { useState } from 'react';
import { ChevronDown, ChevronUp, Image as ImageIcon, AlertTriangle, CheckCircle2, Home } from 'lucide-react';
import type { PersistentData, GuidedCaptureStep } from '../lib/storage';
import type { DiscrepancyResult } from '../lib/api';

type Room = { id: string; name: string; steps: GuidedCaptureStep[] };

interface AlbumViewProps {
  rooms: Room[];
  data: PersistentData;
  discrepancies: DiscrepancyResult[];
}

const ROOM_TYPE_EMOJIS: Record<string, string> = {
  bedroom: '🛏',
  bathroom: '🚿',
  kitchen: '🍳',
  'living-room': '🛋',
};

export default function AlbumView({ rooms, data, discrepancies }: AlbumViewProps) {
  const [expandedRooms, setExpandedRooms] = useState<Record<string, boolean>>(
    Object.fromEntries(rooms.map(r => [r.id, true]))
  );

  const toggleRoom = (roomId: string) => {
    setExpandedRooms(prev => ({ ...prev, [roomId]: !prev[roomId] }));
  };

  const getStepPhotos = (phase: 'move-in' | 'move-out', roomId: string, stepId: string) => {
    return data.photos[phase]?.[roomId]?.[stepId] || [];
  };

  const getDiscrepancy = (roomId: string, stepId: string) => {
    return discrepancies.find(d => d.roomId === roomId && d.stepId === stepId);
  };

  const getCaptureSteps = (room: Room) => {
    const plan = data.capturePlans?.['move-in']?.[room.id] || data.capturePlans?.['move-out']?.[room.id];
    const guidedTasks = plan && plan.source === 'ai' ? plan.tasks : [];
    
    // Overview step
    const overviewStep: GuidedCaptureStep = {
      id: 'overview',
      label: '전체 샷',
      guide: `${room.name}의 구조와 주요 설비가 한눈에 보이도록 한 걸음 물러서서 찍어주세요.`,
      target: room.name,
      angle: 'wide'
    };

    const demoTasks = guidedTasks.slice(0, 2).map(step => ({
      ...step,
      minPhotos: 1,
      coverageCriteria: step.coverageCriteria?.slice(0, 2),
    }));

    return [overviewStep, ...demoTasks];
  };

  return (
    <div className="album-view">
      <div className="view-hero">
        <div className="hero-app-name">
          <ImageIcon size={15} color="rgba(255,255,255,0.75)" />
          <span>점검 사진첩</span>
        </div>
        <h1 className="hero-title">비교 앨범</h1>
        <p className="hero-subtitle">입주 전과 퇴실 당시 찍은 사진을 한눈에 대조해보세요.</p>
      </div>

      <div className="view-shelf">
        {rooms.length === 0 ? (
          <div className="empty-album">
            <ImageIcon size={48} color="#CBD5E4" />
            <p>설정된 공간이 없습니다.</p>
          </div>
        ) : (
          <div className="album-room-list">
            {rooms.map(room => {
              const isExpanded = expandedRooms[room.id] ?? true;
              const steps = getCaptureSteps(room);
              const roomTypeId = room.id.replace(/-\d+$/, '');
              const roomEmoji = ROOM_TYPE_EMOJIS[roomTypeId] || '🏠';

              return (
                <div key={room.id} className="album-room-card">
                  <button className="album-room-header" onClick={() => toggleRoom(room.id)}>
                    <div className="album-room-info">
                      <span className="room-emoji">{roomEmoji}</span>
                      <h3>{room.name}</h3>
                    </div>
                    {isExpanded ? <ChevronUp size={20} /> : <ChevronDown size={20} />}
                  </button>

                  {isExpanded && (
                    <div className="album-room-content">
                      {steps.map(step => {
                        const inPhotos = getStepPhotos('move-in', room.id, step.id);
                        const outPhotos = getStepPhotos('move-out', room.id, step.id);
                        const discrepancy = getDiscrepancy(room.id, step.id);

                        const hasIn = inPhotos.length > 0;
                        const hasOut = outPhotos.length > 0;

                        return (
                          <div key={step.id} className="album-step-row">
                            <h4 className="album-step-label">{step.label}</h4>

                            <div className="album-photo-compare-grid">
                              {/* 입주 전 사진 */}
                              <div className="album-photo-box">
                                <div className="album-photo-badge in">입주 전</div>
                                {hasIn ? (
                                  <img src={inPhotos[0]} alt="입주 전" className="album-compare-img" />
                                ) : (
                                  <div className="album-compare-placeholder">
                                    <ImageIcon size={24} />
                                    <span>촬영된 사진 없음</span>
                                  </div>
                                )}
                              </div>

                              {/* 퇴실 사진 */}
                              <div className="album-photo-box">
                                <div className="album-photo-badge out">퇴실 후</div>
                                {hasOut ? (
                                  <img src={outPhotos[0]} alt="퇴실 후" className="album-compare-img" />
                                ) : (
                                  <div className="album-compare-placeholder">
                                    <ImageIcon size={24} />
                                    <span>촬영 전</span>
                                  </div>
                                )}
                              </div>
                            </div>

                            {/* 비교 분석 결과 데코 */}
                            {discrepancy && (
                              <div className={`album-discrepancy-card ${discrepancy.damageLevel}`}>
                                <div className="discrepancy-card-header">
                                  {discrepancy.damageLevel !== 'none' ? (
                                    <AlertTriangle size={14} />
                                  ) : (
                                    <CheckCircle2 size={14} />
                                  )}
                                  <span className="discrepancy-status">
                                    AI 분석: {discrepancy.damageLevel === 'high' ? '심각한 하자 감지' : discrepancy.damageLevel === 'low' ? '경미한 변형 감지' : '변형 없음'}
                                  </span>
                                </div>
                                <p className="discrepancy-notes">{discrepancy.notes}</p>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
