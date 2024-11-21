import type { CollectionConfig } from 'payload'

const Song: CollectionConfig = {
    slug: 'Song',
    labels: {
        singular: 'Song',
        plural: 'Songs',
    },
    fields: [
        {
            name: 'title',
            label: 'Title',
            type: 'text',
            required: true,
        },
        {
            name: 'lyrics',
            label: 'Lyrics',
            type: 'richText',
            required: true,
        },
    ],
    admin: {
        useAsTitle: 'title',
    },
    timestamps: true,
    disableDuplicate: true,
    auth: true,
};

export default Song;