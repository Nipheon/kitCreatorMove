import { DRUM_CELL_COLOR } from '../padLayout';

export function generateAblPreset(
  kitName: string,
  samples: (string | null)[],
  chokeGroups: (number | null)[],
  categories: (string | null)[],
  sampleNames: (string | null)[] = []
) {
  const chains = samples.map((sampleUri, index) => {
    const category = categories[index];
    const sampleName = sampleNames[index] ?? '';

    // Each effect's amount stays at 0.0 by design: the type is selected so the user
    // can dial it in on the device, not so it colours the sample on import.
    const punchAmount = 0.0;
    const subOscAmount = 0.0;
    const noiseAmount = 0.0;

    let effectType = "Stretch";

    // The 808 check comes first and reads the name, not the category. It used to require
    // `category === 'Other'`, which only worked because the categoriser deliberately left
    // 808s unclassified; now that a bare 808 is a Kick, keying on the category would have
    // silently swapped every 808 from Sub Osc to Punch.
    if (sampleName.toLowerCase().includes('808')) {
      effectType = "Sub Osc";
    } else if (category) {
      if (category === 'Kick') {
        effectType = "Punch";
      } else if (category === 'Snare' || category === 'Clap' || category === 'CHH' || category === 'OHH' || category === 'Hat') {
        effectType = "Noise";
      }
    }

    return {
      "name": "",
      // 5 on every chain, and there is no point varying it: Move ignores this field for
      // pad display. See the entry in AGENTS.md before trying to colour pads through it.
      "color": DRUM_CELL_COLOR,
      "devices": [
        {
          "presetUri": null,
          "kind": "drumCell",
          "name": "",
          "parameters": {
            "Effect_EightBitFilterDecay": 5.0,
            "Effect_EightBitResamplingRate": 14079.9990234375,
            "Effect_FmAmount": 0.0,
            "Effect_FmFrequency": 999.9998168945313,
            "Effect_LoopLength": 0.30000001192092896,
            "Effect_LoopOffset": 0.019999997690320015,
            "Effect_NoiseAmount": noiseAmount,
            "Effect_NoiseFrequency": 10000.0009765625,
            "Effect_On": true,
            "Effect_PitchEnvelopeAmount": 0.0,
            "Effect_PitchEnvelopeDecay": 0.29999998211860657,
            "Effect_PunchAmount": punchAmount,
            "Effect_PunchTime": 0.12015999853610992,
            "Effect_RingModAmount": 0.0,
            "Effect_RingModFrequency": 999.9998168945313,
            "Effect_StretchFactor": 1.0,
            "Effect_StretchGrainSize": 0.09999999403953552,
            "Effect_SubOscAmount": subOscAmount,
            "Effect_SubOscFrequency": 59.9999885559082,
            "Effect_Type": effectType,
            "Enabled": true,
            "NotePitchBend": true,
            "Pan": 0.0,
            "Voice_Detune": 0.0,
            "Voice_Envelope_Attack": 0.00009999999747378752,
            "Voice_Envelope_Decay": 60.0,
            "Voice_Envelope_Hold": 0.0,
            "Voice_Envelope_Mode": "A-H-D",
            "Voice_Filter_Frequency": 21999.990234375,
            "Voice_Filter_On": true,
            "Voice_Filter_PeakGain": 1.0,
            "Voice_Filter_Resonance": 0.0,
            "Voice_Filter_Type": "Lowpass",
            "Voice_Gain": 1.0,
            "Voice_ModulationAmount": 0.0,
            "Voice_ModulationSource": "Velocity",
            "Voice_ModulationTarget": "Filter",
            "Voice_PitchToEnvelopeModulation": false,
            "Voice_PlaybackLength": 1.0,
            "Voice_PlaybackStart": 0.0,
            "Voice_Transpose": 0,
            "Voice_VelocityToVolume": 0.3499999940395355,
            "Volume": -11.999999046325684
          },
          "deviceData": {
            "sampleUri": sampleUri
          }
        }
      ],
      "mixer": {
        "pan": 0.0,
        "solo-cue": false,
        "speakerOn": true,
        "volume": 0.0,
        "sends": [
          {
            "isEnabled": true,
            "amount": -70.0
          }
        ]
      },
      "drumZoneSettings": {
        "receivingNote": 36 + index,
        "sendingNote": 60,
        "chokeGroup": chokeGroups[index]
      }
    };
  });

  return {
    "$schema": "http://tech.ableton.com/schema/song/1.7.0/devicePreset.json",
    "kind": "instrumentRack",
    "name": kitName,
    "parameters": {
      "Enabled": true,
      "Macro0": {
        "value": 0.0,
        "customName": "Nothing needs to be mapped"
      },
      "Macro1": 0.0,
      "Macro2": 0.0,
      "Macro3": 0.0,
      "Macro4": 0.0,
      "Macro5": 0.0,
      "Macro6": 0.0,
      "Macro7": 0.0
    },
    "chains": [
      {
        "name": "",
        "color": 5,
        "devices": [
          {
            "presetUri": null,
            "kind": "drumRack",
            "name": "",
            "parameters": {
              "Enabled": true,
              "Macro0": {
                "value": 0.0,
                "customName": "Nothing needs to be mapped"
              },
              "Macro1": 0.0,
              "Macro2": 0.0,
              "Macro3": 0.0,
              "Macro4": 0.0,
              "Macro5": 0.0,
              "Macro6": 0.0,
              "Macro7": 0.0
            },
            "chains": chains,
            "returnChains": [
              {
                "name": "",
                "color": 5,
                "devices": [
                  {
                    "presetUri": null,
                    "kind": "reverb",
                    "name": "Reverb",
                    "parameters": {
                      "AllPassGain": 0.6,
                      "AllPassSize": 0.4,
                      "BandFreq": 5000.0,
                      "BandHighOn": false,
                      "BandLowOn": true,
                      "BandWidth": 2.0,
                      "ChorusOn": true,
                      "CutOn": true,
                      "DecayTime": 2000.0,
                      "DiffuseDelay": 0.8,
                      "EarlyReflectModDepth": 20.0,
                      "EarlyReflectModFreq": 0.35,
                      "Enabled": true,
                      "FlatOn": true,
                      "FreezeOn": false,
                      "HighFilterType": "Shelf",
                      "MixDiffuse": 1.0,
                      "MixDirect": 0.8,
                      "MixReflect": 1.0,
                      "PreDelay": 10.0,
                      "RoomSize": 20.0,
                      "RoomType": "SuperEco",
                      "ShelfHiFreq": 5000.0,
                      "ShelfHiGain": 0.5,
                      "ShelfHighOn": true,
                      "ShelfLoFreq": 200.0,
                      "ShelfLoGain": 0.35,
                      "ShelfLowOn": true,
                      "SizeModDepth": 0.5,
                      "SizeModFreq": 0.5,
                      "SizeSmoothing": "Fast",
                      "SpinOn": false,
                      "StereoSeparation": 100.0
                    },
                    "deviceData": {}
                  }
                ],
                "mixer": {
                  "pan": 0.0,
                  "solo-cue": false,
                  "speakerOn": true,
                  "volume": 0.0,
                  "sends": [
                    {
                      "isEnabled": false,
                      "amount": -70.0
                    }
                  ]
                }
              }
            ]
          },
          {
            "presetUri": null,
            "kind": "saturator",
            "name": "Saturator",
            "parameters": {
              "BaseDrive": 0.0,
              "BassShaperThreshold": -50.0,
              "ColorDepth": 0.0,
              "ColorFrequency": 999.9998779296876,
              "ColorOn": true,
              "ColorWidth": 0.3,
              "DryWet": 0.0,
              "Enabled": true,
              "Oversampling": false,
              "PostClip": "off",
              "PostDrive": 0.0,
              "PreDcFilter": false,
              "PreDrive": 0.0,
              "Type": "Analog Clip",
              "WsCurve": 0.05,
              "WsDamp": 0.0,
              "WsDepth": 0.0,
              "WsDrive": 1.0,
              "WsLin": 0.5,
              "WsPeriod": 0.0
            },
            "deviceData": {}
          }
        ],
        "mixer": {
          "pan": 0.0,
          "solo-cue": false,
          "speakerOn": true,
          "volume": 0.0,
          "sends": []
        }
      }
    ]
  };
}
