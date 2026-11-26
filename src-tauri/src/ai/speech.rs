use std::fs;
use std::path::Path;

use anyhow::{Result, anyhow};
use ort::session::Session;
use ort::session::builder::GraphOptimizationLevel;
use ort::value::TensorRef;
use serde::Serialize;

use crate::ai::models::session_builder;

pub const SAMPLE_RATE: usize = 16_000;
const FRAME_SECONDS: f64 = 0.08;
const DURATIONS: [usize; 5] = [0, 1, 2, 3, 4];
const MAX_TOKENS_PER_FRAME: usize = 10;
const WORD_MARK: char = '\u{2581}';

#[derive(Serialize, Clone, Debug)]
pub struct Word {
    pub start: f64,
    pub end: f64,
    pub text: String,
}

pub struct SpeechRecognizer {
    preprocessor: Session,
    encoder: Session,
    decoder: Session,
    vocab: Vec<String>,
    blank: usize,
    state_shape: [usize; 3],
}

fn load_session(path: &Path) -> ort::Result<Session> {
    session_builder()?
        .with_optimization_level(GraphOptimizationLevel::Level3)?
        .commit_from_file(path)
}

fn argmax(values: &[f32]) -> usize {
    values
        .iter()
        .enumerate()
        .fold((0, f32::NEG_INFINITY), |best, (index, value)| {
            if *value > best.1 {
                (index, *value)
            } else {
                best
            }
        })
        .0
}

fn is_punctuation(piece: &str) -> bool {
    !piece.chars().any(char::is_alphanumeric)
}

impl SpeechRecognizer {
    pub fn load(dir: &Path) -> Result<Self> {
        let mut vocab = Vec::new();
        for line in fs::read_to_string(dir.join("vocab.txt"))?.lines() {
            let Some((token, index)) = line.rsplit_once(' ') else {
                continue;
            };
            let index: usize = index.parse()?;
            if vocab.len() <= index {
                vocab.resize(index + 1, String::new());
            }
            vocab[index] = token.replace(WORD_MARK, " ");
        }
        let blank = vocab
            .iter()
            .position(|token| token == "<blk>")
            .ok_or_else(|| anyhow!("The speech vocabulary has no blank token"))?;
        let decoder = load_session(&dir.join("decoder_joint-model.int8.onnx"))?;
        let state = decoder
            .inputs()
            .iter()
            .find(|input| input.name() == "input_states_1")
            .and_then(|input| input.dtype().tensor_shape())
            .ok_or_else(|| anyhow!("The speech decoder has no state input"))?;
        let state_shape = match state[..] {
            [layers, _, size] if layers > 0 && size > 0 => [layers as usize, 1, size as usize],
            _ => return Err(anyhow!("Unexpected speech decoder state shape")),
        };
        Ok(Self {
            preprocessor: load_session(&dir.join("nemo128.onnx"))?,
            encoder: load_session(&dir.join("encoder-model.int8.onnx"))?,
            decoder,
            vocab,
            blank,
            state_shape,
        })
    }

    fn encode(&mut self, samples: &[f32]) -> Result<(Vec<f32>, usize, usize)> {
        let lengths = [samples.len() as i64];
        let outputs = self.preprocessor.run(ort::inputs![
            "waveforms" => TensorRef::from_array_view(([1usize, samples.len()], samples))?,
            "waveforms_lens" => TensorRef::from_array_view(([1usize], &lengths[..]))?,
        ])?;
        let features = outputs["features"].try_extract_array::<f32>()?.to_owned();
        let feature_lengths = outputs["features_lens"]
            .try_extract_array::<i64>()?
            .to_owned();
        drop(outputs);
        let outputs = self.encoder.run(ort::inputs![
            "audio_signal" => TensorRef::from_array_view(&features)?,
            "length" => TensorRef::from_array_view(&feature_lengths)?,
        ])?;
        let encoded = outputs["outputs"].try_extract_array::<f32>()?;
        let frames = outputs["encoded_lengths"].try_extract_tensor::<i64>()?.1[0].max(0) as usize;
        let (dim, available) = match encoded.shape() {
            [1, dim, available] => (*dim, *available),
            _ => return Err(anyhow!("Unexpected speech encoder output shape")),
        };
        let frames = frames.min(available);
        let by_frame = encoded
            .index_axis(ndarray::Axis(0), 0)
            .t()
            .slice(ndarray::s![..frames, ..])
            .as_standard_layout()
            .into_owned();
        Ok((by_frame.into_raw_vec_and_offset().0, frames, dim))
    }

    pub fn transcribe(&mut self, samples: &[f32], offset: f64) -> Result<Vec<Word>> {
        let (encoded, frames, dim) = self.encode(samples)?;
        let state_size = self.state_shape.iter().product();
        let mut states = [vec![0f32; state_size], vec![0f32; state_size]];
        let target_length = [1i32];
        let mut tokens: Vec<(usize, usize)> = Vec::new();
        let (mut frame, mut emitted) = (0, 0);
        while frame < frames {
            let target = [tokens.last().map_or(self.blank, |token| token.0) as i32];
            let outputs = self.decoder.run(ort::inputs![
                "encoder_outputs" => TensorRef::from_array_view(([1usize, dim, 1], &encoded[frame * dim..(frame + 1) * dim]))?,
                "targets" => TensorRef::from_array_view(([1usize, 1], &target[..]))?,
                "target_length" => TensorRef::from_array_view(([1usize], &target_length[..]))?,
                "input_states_1" => TensorRef::from_array_view((self.state_shape, &states[0][..]))?,
                "input_states_2" => TensorRef::from_array_view((self.state_shape, &states[1][..]))?,
            ])?;
            let logits = outputs["outputs"].try_extract_tensor::<f32>()?.1;
            if logits.len() < self.blank + 1 + DURATIONS.len() {
                return Err(anyhow!("Unexpected speech decoder output size"));
            }
            let token = argmax(&logits[..=self.blank]);
            let step = DURATIONS[argmax(&logits[self.blank + 1..self.blank + 1 + DURATIONS.len()])];
            if token != self.blank {
                for (state, name) in states
                    .iter_mut()
                    .zip(["output_states_1", "output_states_2"])
                {
                    state.copy_from_slice(outputs[name].try_extract_tensor::<f32>()?.1);
                }
                tokens.push((token, frame));
                emitted += 1;
            }
            if step > 0 {
                frame += step;
                emitted = 0;
            } else if token == self.blank || emitted == MAX_TOKENS_PER_FRAME {
                frame += 1;
                emitted = 0;
            }
        }
        Ok(self.words(&tokens, offset))
    }

    fn words(&self, tokens: &[(usize, usize)], offset: f64) -> Vec<Word> {
        let mut words: Vec<Word> = Vec::new();
        for &(token, frame) in tokens {
            let piece = &self.vocab[token];
            if piece.is_empty() || (piece.starts_with('<') && piece.ends_with('>')) {
                continue;
            }
            let time = offset + frame as f64 * FRAME_SECONDS;
            let punctuation = is_punctuation(piece);
            match words.last_mut() {
                Some(word) if punctuation || !piece.starts_with(' ') => {
                    word.text.push_str(piece);
                    if !punctuation {
                        word.end = time + FRAME_SECONDS;
                    }
                }
                _ if punctuation => {}
                _ => words.push(Word {
                    start: time,
                    end: time + FRAME_SECONDS,
                    text: piece.trim_start().to_string(),
                }),
            }
        }
        for index in 1..words.len() {
            let next_start = words[index].start;
            let word = &mut words[index - 1];
            word.end = word.end.min(next_start).max(word.start);
        }
        for word in &mut words {
            word.text = word.text.trim().to_string();
        }
        words
    }
}
