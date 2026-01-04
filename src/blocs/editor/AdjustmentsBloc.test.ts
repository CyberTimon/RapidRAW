import { describe, it, expect, beforeEach } from 'vitest';
import { AdjustmentsBloc } from './AdjustmentsBloc';
import { INITIAL_ADJUSTMENTS, DEFAULT_CURVES, DEFAULT_HSL } from '../../types/adjustments';

describe('AdjustmentsBloc', () => {
  let bloc: AdjustmentsBloc;

  beforeEach(() => {
    bloc = new AdjustmentsBloc();
  });

  describe('initial state', () => {
    it('should have default adjustments', () => {
      expect(bloc.state.adjustments).toEqual(INITIAL_ADJUSTMENTS);
    });

    it('should not be dirty', () => {
      expect(bloc.state.isDirty).toBe(false);
    });

    it('should have no last saved timestamp', () => {
      expect(bloc.state.lastSavedAt).toBeNull();
    });
  });

  describe('basic adjustments', () => {
    it('setExposure should update exposure', () => {
      bloc.setExposure(0.5);
      expect(bloc.state.adjustments.exposure).toBe(0.5);
      expect(bloc.state.isDirty).toBe(true);
    });

    it('setContrast should update contrast', () => {
      bloc.setContrast(25);
      expect(bloc.state.adjustments.contrast).toBe(25);
    });

    it('setHighlights should update highlights', () => {
      bloc.setHighlights(-30);
      expect(bloc.state.adjustments.highlights).toBe(-30);
    });

    it('setShadows should update shadows', () => {
      bloc.setShadows(40);
      expect(bloc.state.adjustments.shadows).toBe(40);
    });
  });

  describe('color adjustments', () => {
    it('setTemperature should update temperature', () => {
      bloc.setTemperature(20);
      expect(bloc.state.adjustments.temperature).toBe(20);
    });

    it('setSaturation should update saturation', () => {
      bloc.setSaturation(15);
      expect(bloc.state.adjustments.saturation).toBe(15);
    });

    it('setVibrance should update vibrance', () => {
      bloc.setVibrance(10);
      expect(bloc.state.adjustments.vibrance).toBe(10);
    });
  });

  describe('complex adjustments', () => {
    it('setVignette should merge with existing vignette', () => {
      bloc.setVignette({ amount: -30 });
      expect(bloc.state.adjustments.vignette.amount).toBe(-30);
      expect(bloc.state.adjustments.vignette.feather).toBe(INITIAL_ADJUSTMENTS.vignette.feather);
    });

    it('setGrain should merge with existing grain', () => {
      bloc.setGrain({ amount: 20, size: 50 });
      expect(bloc.state.adjustments.grain.amount).toBe(20);
      expect(bloc.state.adjustments.grain.size).toBe(50);
    });

    it('setCurves should merge with existing curves', () => {
      const newRgbCurve = [
        { x: 0, y: 0 },
        { x: 0.25, y: 0.3 },
        { x: 1, y: 1 },
      ];
      bloc.setCurves({ rgb: newRgbCurve });
      expect(bloc.state.adjustments.curves.rgb).toEqual(newRgbCurve);
      expect(bloc.state.adjustments.curves.red).toEqual(DEFAULT_CURVES.red);
    });

    it('setCurveChannel should update specific curve', () => {
      const newCurve = [
        { x: 0, y: 0 },
        { x: 0.5, y: 0.6 },
        { x: 1, y: 1 },
      ];
      bloc.setCurveChannel('red', newCurve);
      expect(bloc.state.adjustments.curves.red).toEqual(newCurve);
    });

    it('setHSLChannel should update specific HSL channel', () => {
      bloc.setHSLChannel('red', { saturation: 20, luminance: -10 });
      expect(bloc.state.adjustments.hsl.red.saturation).toBe(20);
      expect(bloc.state.adjustments.hsl.red.luminance).toBe(-10);
      expect(bloc.state.adjustments.hsl.red.hue).toBe(DEFAULT_HSL.red.hue);
    });
  });

  describe('transform operations', () => {
    it('setRotation should update rotation', () => {
      bloc.setRotation(90);
      expect(bloc.state.adjustments.rotation).toBe(90);
    });

    it('toggleFlipHorizontal should toggle flip', () => {
      expect(bloc.state.adjustments.flipHorizontal).toBe(false);
      bloc.toggleFlipHorizontal();
      expect(bloc.state.adjustments.flipHorizontal).toBe(true);
      bloc.toggleFlipHorizontal();
      expect(bloc.state.adjustments.flipHorizontal).toBe(false);
    });

    it('setCrop should set crop data', () => {
      const crop = { x: 10, y: 10, width: 100, height: 100, unit: 'px' as const };
      bloc.setCrop(crop);
      expect(bloc.state.adjustments.crop).toEqual(crop);
    });
  });

  describe('rating', () => {
    it('setRating should clamp value between 0 and 5', () => {
      bloc.setRating(3);
      expect(bloc.state.adjustments.rating).toBe(3);

      bloc.setRating(-1);
      expect(bloc.state.adjustments.rating).toBe(0);

      bloc.setRating(10);
      expect(bloc.state.adjustments.rating).toBe(5);
    });
  });

  describe('bulk operations', () => {
    it('setAdjustments should merge multiple adjustments', () => {
      bloc.setAdjustments({
        exposure: 0.5,
        contrast: 20,
        saturation: 10,
      });
      expect(bloc.state.adjustments.exposure).toBe(0.5);
      expect(bloc.state.adjustments.contrast).toBe(20);
      expect(bloc.state.adjustments.saturation).toBe(10);
    });

    it('loadAdjustments should replace all adjustments', () => {
      const customAdjustments = {
        ...INITIAL_ADJUSTMENTS,
        exposure: 1.0,
        contrast: 50,
      };
      bloc.loadAdjustments(customAdjustments);
      expect(bloc.state.adjustments).toEqual(customAdjustments);
      expect(bloc.state.isDirty).toBe(false);
    });
  });

  describe('reset operations', () => {
    it('resetAll should restore initial adjustments', () => {
      bloc.setExposure(1.0);
      bloc.setContrast(50);
      bloc.resetAll();
      expect(bloc.state.adjustments).toEqual(INITIAL_ADJUSTMENTS);
      expect(bloc.state.isDirty).toBe(true);
    });

    it('resetBasic should only reset basic adjustments', () => {
      bloc.setExposure(0.5);
      bloc.setSaturation(20);
      bloc.resetBasic();
      expect(bloc.state.adjustments.exposure).toBe(0);
      expect(bloc.state.adjustments.saturation).toBe(20);
    });

    it('resetColor should only reset color adjustments', () => {
      bloc.setExposure(0.5);
      bloc.setSaturation(20);
      bloc.resetColor();
      expect(bloc.state.adjustments.exposure).toBe(0.5);
      expect(bloc.state.adjustments.saturation).toBe(0);
    });

    it('resetCurves should restore default curves', () => {
      bloc.setCurveChannel('rgb', [{ x: 0, y: 0.5 }, { x: 1, y: 0.5 }]);
      bloc.resetCurves();
      expect(bloc.state.adjustments.curves).toEqual(DEFAULT_CURVES);
    });

    it('resetHSL should restore default HSL', () => {
      bloc.setHSLChannel('red', { hue: 30 });
      bloc.resetHSL();
      expect(bloc.state.adjustments.hsl).toEqual(DEFAULT_HSL);
    });
  });

  describe('dirty state', () => {
    it('markSaved should clear dirty flag', () => {
      bloc.setExposure(0.5);
      expect(bloc.state.isDirty).toBe(true);
      bloc.markSaved();
      expect(bloc.state.isDirty).toBe(false);
      expect(bloc.state.lastSavedAt).not.toBeNull();
    });
  });

  describe('current getter', () => {
    it('should return current adjustments', () => {
      bloc.setExposure(0.7);
      expect(bloc.current.exposure).toBe(0.7);
    });
  });
});
