export function generateAblPreset(kitName: string, samples: (string | null)[], chokeGroups: (number | null)[]) {
  const chains = samples.map((sampleUri, index) => {
    return {
      "name": "",
      "color": 5,
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
            "Effect_NoiseAmount": 0.0,
            "Effect_NoiseFrequency": 10000.0009765625,
            "Effect_On": true,
            "Effect_PitchEnvelopeAmount": 0.0,
            "Effect_PitchEnvelopeDecay": 0.29999998211860657,
            "Effect_PunchAmount": 0.0,
            "Effect_PunchTime": 0.12015999853610992,
            "Effect_RingModAmount": 0.0,
            "Effect_RingModFrequency": 999.9998168945313,
            "Effect_StretchFactor": 1.0,
            "Effect_StretchGrainSize": 0.09999999403953552,
            "Effect_SubOscAmount": 0.0,
            "Effect_SubOscFrequency": 59.9999885559082,
            "Effect_Type": "Stretch",
            "Enabled": true,
            "NotePitchBend": true,
            "Pan": 0.0,
            "Voice_Detune": 0.0,
            "Voice_Envelope_Attack": 0.00009999999747378752,
            "Voice_Envelope_Decay": 1.0,
            "Voice_Envelope_Hold": 0.3000001013278961,
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
                    "name": "Swap for other Move/Note-compatible FX",
                    "parameters": {
                      "AllPassGain": 0.6000000238418579,
                      "AllPassSize": 0.4000000059604645,
                      "BandFreq": 829.999755859375,
                      "BandHighOn": false,
                      "BandLowOn": true,
                      "BandWidth": 5.849999904632568,
                      "ChorusOn": true,
                      "CutOn": true,
                      "DecayTime": 1200.000244140625,
                      "DiffuseDelay": 0.5,
                      "EarlyReflectModDepth": 17.499998092651367,
                      "EarlyReflectModFreq": 0.29770004749298096,
                      "Enabled": true,
                      "FlatOn": true,
                      "FreezeOn": false,
                      "HighFilterType": "Shelf",
                      "MixDiffuse": 1.0,
                      "MixDirect": 0.550000011920929,
                      "MixReflect": 1.0,
                      "PreDelay": 2.500000238418579,
                      "RoomSize": 99.99998474121094,
                      "RoomType": "SuperEco",
                      "ShelfHiFreq": 4500.00146484375,
                      "ShelfHiGain": 0.699999988079071,
                      "ShelfHighOn": true,
                      "ShelfLoFreq": 90.0,
                      "ShelfLoGain": 1.0,
                      "ShelfLowOn": true,
                      "SizeModDepth": 0.019999999552965164,
                      "SizeModFreq": 0.020000003278255463,
                      "SizeSmoothing": "Fast",
                      "SpinOn": true,
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
            "name": "Swap for other Move/Note-compatible FX",
            "parameters": {
              "BaseDrive": 0.0,
              "BassShaperThreshold": -50.0,
              "ColorDepth": 0.0,
              "ColorFrequency": 999.9998168945313,
              "ColorOn": true,
              "ColorWidth": 0.30000001192092896,
              "DryWet": 1.0,
              "Enabled": true,
              "Oversampling": false,
              "PostClip": "off",
              "PostDrive": 0.0,
              "PreDcFilter": false,
              "PreDrive": 0.0,
              "Type": "Analog Clip",
              "WsCurve": 0.05000000074505806,
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
